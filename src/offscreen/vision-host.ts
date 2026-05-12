/**
 * VisionHost — owns the image-model worker in the offscreen document and
 * answers image classification requests. Independent of EngineHost (text):
 * its own worker, queue, caches, status and failure handling, so slow image
 * work never delays text verdicts and a vision failure never degrades text
 * filtering.
 *
 * Two workers (same bundle, src/vision/vision.worker.ts):
 *   image — the image encoder, kept while image filtering is on;
 *   text  — the text encoder, started only when a topic has no cached
 *           embedding yet and stopped after TEXT_IDLE_MS, because a
 *           WebAssembly heap is only returned to the system when its worker
 *           ends (each encoder costs ≈ 0.33–0.37 GB once loaded).
 * The generic background prompts are embedded at build time
 * (offscreen/vision/background.json, same runtime and model); if that file is
 * missing or does not match, they are embedded by the text worker instead.
 *
 * Lifecycle: nothing is loaded until the first image request (image filtering
 * on, an eligible image near the viewport). `shutdown()` (image filtering
 * turned off) terminates both workers and drops every cache.
 *
 * Scheduling: one job at a time, FIFO, at most MAX_QUEUED_JOBS waiting
 * (overflow is refused as "overloaded"; the content script retries later).
 * Per frame only the newest settings generation is served: older queued jobs
 * are answered `stale` without running inference.
 *
 * Caches (memory only, never persisted): image embeddings by image identity
 * (URL for downloads, SHA-256 of the RGB frame for page pixels) — topic-
 * independent, so changing topics re-scores cached images without inference;
 * topic embeddings by topic text. Both are cleared with the worker.
 *
 * Downloads (only for URL requests the service worker approved): no redirects
 * are followed (`redirect: "manual"`; any redirect response, including the
 * opaque one cross-origin redirects produce, is refused), so no request is
 * ever made to an address that was not checked. Every download has an
 * AbortController; `shutdown()` and `revokeDownloads()` abort all of them at
 * once, and a request approved before a revocation (its `downloadGrant` is
 * older than the latest revocation) is refused without network access.
 *
 * Late requests: a request authorised by the service worker before image
 * filtering was turned off carries an older `visionGrant` than the
 * shutdown's `revokedAt` and is refused in classify(), before the model is
 * touched — so a delayed message cannot load the model again.
 *
 * Lifecycle epoch: `shutdown()` starts a new epoch. Work begun in an earlier
 * epoch — a job already running, a model still initialising — re-checks the
 * epoch after every await and stops: it cannot download, start a worker,
 * fill a cache or report a status after shutdown.
 *
 * Failures: initialisation failure or timeout → state "error" (truthfully
 * reported; images are left visible) and a new attempt after
 * RECOVERY_COOLDOWN_MS. An image-worker crash or inference timeout restarts
 * it (at most MAX_RESTARTS times, then "error"). A text-worker failure fails
 * the jobs that needed it (retryable) and the next topic starts a new one.
 */

import { LruCache } from "./lru.ts";
import {
  usableBackground,
  checkImageUrl,
  decideImage,
  meanVector,
  prepareVisionTopic,
  topicPrompts,
  VISION_BACKGROUND_PROMPTS,
  VISION_LIMITS,
  VISION_MODEL_ID,
  type OffscreenVision,
  type PreparedVisionTopic,
  type SkipReason,
  type VisionReply,
  type VisionStatus,
  type VisionWorkerRequest,
  type VisionWorkerResponse,
} from "../shared/vision.ts";
import { base64ToBytes } from "../vision/preprocess.ts";

const MAX_QUEUED_JOBS = 32;
const MAX_TRACKED_FRAMES = 1000;
const MAX_RESTARTS = 2;
const RECOVERY_COOLDOWN_MS = 5 * 60_000;
const IMAGE_CACHE_SIZE = 1000;
const TOPIC_CACHE_SIZE = 64;
/** The text encoder is released this long after its last use. */
const TEXT_IDLE_MS = 20_000;
/** Downloaded body types accepted (SVG is excluded: icons, and not decodable in workers). */
const IMAGE_TYPES = /^image\/(jpeg|pjpeg|png|webp|avif|gif|bmp|x-ms-bmp)$/;

export interface VisionWorkerLike {
  postMessage(msg: VisionWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<VisionWorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

export interface VisionHostDeps {
  createWorker(): VisionWorkerLike;
  assetUrl(path: string): string;
  fetch: typeof fetch;
  onStatus(status: VisionStatus): void;
  now(): number;
  sha256(data: string): Promise<string>;
  /**
   * WebAssembly threads for the image encoder (used only where the worker is
   * cross-origin isolated; default 1).
   */
  threads?: number;
  /** Threads for the short-lived text encoder (default 1). */
  textThreads?: number;
  /** offscreen/vision/background.json (optional; validated before use). */
  loadBackground?(): Promise<unknown>;
  initTimeoutMs?: number;
  jobTimeoutMs?: number;
  maxQueuedJobs?: number;
  textIdleMs?: number;
}

export interface VisionStats {
  jobs: number;
  inferred: number;
  cacheHits: number;
  staleDropped: number;
  overloadRejected: number;
  downloads: number;
  downloadBytes: number;
  skipped: Partial<Record<SkipReason, number>>;
  inferMs: number;
  /** How often the text encoder was started (new topics after it idled out). */
  textWorkerStarts: number;
  backgroundPrecomputed: boolean | null;
}

type Role = "image" | "text";

interface Job {
  msg: OffscreenVision;
  resolve(r: VisionReply): void;
}

interface Pending {
  role: Role;
  resolve(msg: VisionWorkerResponse): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class Skip extends Error {
  readonly reason: SkipReason;

  constructor(reason: SkipReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export class VisionHost {
  private status: VisionStatus;
  private readonly workers: Record<Role, VisionWorkerLike | null> = { image: null, text: null };
  private ready: Promise<boolean> | null = null;
  private textReady: Promise<void> | null = null;
  private textIdle: ReturnType<typeof setTimeout> | null = null;
  private failedAt: number | null = null;
  private restarts = 0;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly queue: Job[] = [];
  private running = false;
  private readonly latestGeneration = new LruCache<string, number>(MAX_TRACKED_FRAMES);
  private readonly images = new LruCache<string, Float32Array>(IMAGE_CACHE_SIZE);
  private readonly topics = new LruCache<string, Float32Array>(TOPIC_CACHE_SIZE);
  private background: Float32Array[] | null = null;
  private readonly initTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly textIdleMs: number;
  readonly queueCapacity: number;
  /** Incremented by shutdown(); async work from an older epoch stops. */
  private epoch = 0;
  /** Downloads in flight. */
  private readonly downloads = new Set<AbortController>();
  /** Latest download revocation (service-worker timestamp); older grants are refused. */
  private downloadsRevokedAt = 0;
  /** Latest image-filtering shutdown (service-worker timestamp); older requests are refused. */
  private imagesRevokedAt = 0;
  /** Rejects a worker initialisation that is still in progress. */
  private readonly initAborts: Partial<Record<Role, (err: Error) => void>> = {};
  readonly stats: VisionStats = { jobs: 0, inferred: 0, cacheHits: 0, staleDropped: 0, overloadRejected: 0, downloads: 0, downloadBytes: 0, skipped: {}, inferMs: 0, textWorkerStarts: 0, backgroundPrecomputed: null };
  private readonly deps: VisionHostDeps;

  constructor(deps: VisionHostDeps) {
    this.deps = deps;
    this.status = { state: "idle", backend: null, model: VISION_MODEL_ID, detail: null, loadMs: null, updatedAt: deps.now() };
    this.initTimeoutMs = deps.initTimeoutMs ?? 120_000;
    this.jobTimeoutMs = deps.jobTimeoutMs ?? 30_000;
    this.queueCapacity = deps.maxQueuedJobs ?? MAX_QUEUED_JOBS;
    this.textIdleMs = deps.textIdleMs ?? TEXT_IDLE_MS;
  }

  getStatus(): VisionStatus {
    return this.status;
  }

  private setStatus(patch: Partial<VisionStatus>): void {
    this.status = { ...this.status, ...patch, updatedAt: this.deps.now() };
    this.deps.onStatus(this.status);
  }

  /**
   * Image filtering was turned off (at service-worker time `revokedAt`):
   * release the models and everything cached, and refuse requests
   * authorised before that time.
   */
  shutdown(revokedAt = this.imagesRevokedAt): void {
    this.imagesRevokedAt = Math.max(this.imagesRevokedAt, revokedAt);
    this.epoch++;
    this.abortDownloads(new Skip("disabled", "image filtering turned off"));
    for (const job of this.queue.splice(0)) job.resolve(this.skipReply(job.msg, new Skip("disabled", "image filtering turned off")));
    this.stopWorker("image");
    this.stopWorker("text");
    this.images.clear();
    this.topics.clear();
    this.background = null;
    this.ready = null;
    this.failedAt = null;
    this.restarts = 0;
    if (this.status.state !== "idle") this.setStatus({ state: "idle", backend: null, threads: null, detail: null, loadMs: null });
  }

  /**
   * Download permission was withdrawn (at service-worker time `revokedAt`):
   * abort every download in flight; requests approved earlier are refused.
   * The models, caches and pixel-based analysis are unaffected.
   */
  revokeDownloads(revokedAt: number): void {
    this.downloadsRevokedAt = Math.max(this.downloadsRevokedAt, revokedAt);
    this.abortDownloads(new Skip("downloads-off", "image downloads were turned off"));
  }

  /** Number of downloads in flight (diagnostics and tests). */
  activeDownloads(): number {
    return this.downloads.size;
  }

  private abortDownloads(reason: Skip): void {
    for (const ctrl of this.downloads) ctrl.abort(reason);
    this.downloads.clear();
  }

  /** Throws when work started in `epoch` was overtaken by shutdown(). */
  private alive(epoch: number): void {
    if (epoch !== this.epoch) throw new Skip("disabled", "image filtering turned off");
  }

  classify(msg: OffscreenVision): Promise<VisionReply> {
    // Authorised before image filtering was last turned off: never loads the model.
    if (!(typeof msg.visionGrant === "number" && msg.visionGrant >= this.imagesRevokedAt)) {
      return Promise.resolve(this.skipReply(msg, new Skip("disabled", "image filtering was turned off")));
    }
    const latest = this.latestGeneration.get(msg.frameKey);
    if (latest !== undefined && msg.generation < latest) {
      this.stats.staleDropped++;
      return Promise.resolve(this.skipReply(msg, new Skip("stale", "stale")));
    }
    if (latest === undefined || msg.generation > latest) {
      this.latestGeneration.set(msg.frameKey, msg.generation);
      this.dropSuperseded(msg.frameKey, msg.generation);
    }
    if (this.queue.length >= this.queueCapacity) {
      this.stats.overloadRejected++;
      return Promise.resolve(this.skipReply(msg, new Skip("overloaded", `${this.queue.length} image requests waiting`)));
    }
    return new Promise((resolve) => {
      this.queue.push({ msg, resolve });
      void this.pump();
    });
  }

  private dropSuperseded(frameKey: string, generation: number): void {
    let kept = 0;
    for (const job of this.queue) {
      if (job.msg.frameKey === frameKey && job.msg.generation < generation) {
        this.stats.staleDropped++;
        job.resolve(this.skipReply(job.msg, new Skip("stale", "stale")));
      } else {
        this.queue[kept++] = job;
      }
    }
    this.queue.length = kept;
  }

  private skipReply(msg: OffscreenVision, err: Skip): VisionReply {
    if (err.reason !== "stale") this.stats.skipped[err.reason] = (this.stats.skipped[err.reason] ?? 0) + 1;
    return { ok: false, generation: msg.generation, reason: err.reason, error: err.message, vision: this.status };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        let reply: VisionReply;
        try {
          reply = await this.run(job.msg);
        } catch (err) {
          reply = this.skipReply(job.msg, err instanceof Skip ? err : new Skip("inference", errorText(err)));
        }
        job.resolve(reply);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(msg: OffscreenVision): Promise<VisionReply> {
    this.stats.jobs++;
    const epoch = this.epoch;
    const ready = await this.ensureReady();
    this.alive(epoch);
    if (!ready) throw new Skip("unavailable", this.status.detail ?? "image model unavailable");
    // Image and topics in parallel: the text encoder (new topics only) and the
    // image encoder run in different workers.
    const [image, text] = await Promise.allSettled([this.acquire(msg, epoch).then((input) => this.embedImage(input)), this.prepareTopics(msg.topics.map((t) => t.text))]);
    this.alive(epoch);
    if (image.status === "rejected") throw image.reason;
    if (text.status === "rejected") throw text.reason;
    const vector = image.value;
    const topics = text.value;
    const prepared = msg.topics.map((t, i): PreparedVisionTopic => ({ ...topics[i]!, id: t.id }));
    return { ok: true, generation: msg.generation, decision: decideImage(vector, prepared, msg.mode), vision: this.status };
  }

  private async embedImage(input: { key: string; cached?: Float32Array; rgb?: Uint8Array; blob?: Blob }): Promise<Float32Array> {
    if (input.cached) {
      this.stats.cacheHits++;
      return input.cached;
    }
    const req: VisionWorkerRequest = input.rgb ? { type: "image", id: 0, rgb: input.rgb, maxPixels: VISION_LIMITS.maxDecodedPixels } : { type: "image", id: 0, blob: input.blob!, maxPixels: VISION_LIMITS.maxDecodedPixels };
    const res = await this.call("image", req, input.rgb ? [input.rgb.buffer as ArrayBuffer] : []);
    if (res.type === "failed") throw new Skip(res.reason, res.error);
    if (res.type !== "image-done") throw new Skip("inference", `unexpected worker reply ${res.type}`);
    this.stats.inferred++;
    this.stats.inferMs += res.ms;
    this.images.set(input.key, res.vector);
    return res.vector;
  }

  /** The image's cache key plus its cached embedding, or the data to embed. */
  private async acquire(msg: OffscreenVision, epoch: number): Promise<{ key: string; cached?: Float32Array; rgb?: Uint8Array; blob?: Blob }> {
    if (msg.image.kind === "pixels") {
      const key = `p:${await this.deps.sha256(msg.image.rgb)}`;
      const cached = this.images.get(key);
      return cached ? { key, cached } : { key, rgb: base64ToBytes(msg.image.rgb) };
    }
    // Approved by the service worker before the latest revocation: refused.
    if (!(typeof msg.downloadGrant === "number" && msg.downloadGrant >= this.downloadsRevokedAt)) throw new Skip("downloads-off", "image downloads are not allowed");
    const checked = checkImageUrl(msg.image.url);
    if (!checked.ok) throw new Skip("ineligible-url", checked.error);
    const key = `u:${checked.url.href}`;
    const cached = this.images.get(key);
    return cached ? { key, cached } : { key, blob: await this.download(checked.url, epoch) };
  }

  /**
   * Download one image the page displays: no cookies or other credentials,
   * no referrer, bounded time and size, image types only, and no redirects —
   * with `redirect: "manual"` the browser returns the redirect itself
   * (status 3xx, or an opaque "opaqueredirect" response for cross-origin
   * redirects, whose target cannot even be read), so the target is never
   * requested. Validating each hop instead is not possible with fetch: the
   * Location of an opaque redirect is not exposed.
   */
  private async download(url: URL, epoch: number): Promise<Blob> {
    this.alive(epoch);
    const ctrl = new AbortController();
    this.downloads.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(new Skip("download-failed", "download timed out")), VISION_LIMITS.downloadTimeoutMs);
    const aborted = (err: unknown): Skip => (ctrl.signal.aborted ? (ctrl.signal.reason instanceof Skip ? ctrl.signal.reason : new Skip("download-failed", "download aborted")) : new Skip("download-failed", errorText(err)));
    try {
      let res: Response;
      try {
        res = await this.deps.fetch(url.href, { credentials: "omit", referrerPolicy: "no-referrer", cache: "default", redirect: "manual", signal: ctrl.signal });
      } catch (err) {
        throw aborted(err);
      }
      if (ctrl.signal.aborted) throw aborted(null);
      if (res.type === "opaqueredirect" || res.redirected || (res.status >= 300 && res.status < 400)) {
        void res.body?.cancel().catch(() => undefined);
        throw new Skip("download-failed", "redirects are not followed");
      }
      if (!res.ok) throw new Skip("download-failed", `HTTP ${res.status}`);
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.test(type)) throw new Skip("download-failed", `not a supported image type (${type || "none"})`);
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > VISION_LIMITS.maxDownloadBytes) throw new Skip("too-large", `image is ${declared} bytes`);
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new Skip("download-failed", "empty response");
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } catch (err) {
          throw aborted(err);
        }
        if (ctrl.signal.aborted) {
          void reader.cancel().catch(() => undefined);
          throw aborted(null);
        }
        if (r.done) break;
        total += r.value.length;
        if (total > VISION_LIMITS.maxDownloadBytes) {
          void reader.cancel().catch(() => undefined);
          throw new Skip("too-large", `image exceeds ${VISION_LIMITS.maxDownloadBytes} bytes`);
        }
        chunks.push(r.value);
      }
      this.alive(epoch);
      this.stats.downloads++;
      this.stats.downloadBytes += total;
      return new Blob(chunks as BlobPart[], { type });
    } finally {
      clearTimeout(timer);
      this.downloads.delete(ctrl);
    }
  }

  /** Embeddings for topics (cached by text) and, if not precomputed, the background prompts. */
  private async prepareTopics(texts: string[]): Promise<PreparedVisionTopic[]> {
    const missing = [...new Set(texts.filter((t) => !this.topics.get(t)))];
    const prompts = missing.flatMap(topicPrompts);
    const needBackground = this.background === null;
    if (needBackground) prompts.push(...VISION_BACKGROUND_PROMPTS);
    if (prompts.length > 0) {
      await this.ensureTextWorker();
      const res = await this.call("text", { type: "text", id: 0, prompts });
      this.scheduleTextIdle();
      if (res.type !== "text-done") throw new Skip("inference", res.type === "failed" ? res.error : `unexpected worker reply ${res.type}`);
      const dim = res.vectors.length / prompts.length;
      const per = topicPrompts("x").length;
      missing.forEach((t, i) => this.topics.set(t, meanVector(res.vectors.slice(i * per * dim, (i + 1) * per * dim), per)));
      if (needBackground) {
        const off = missing.length * per;
        this.background = VISION_BACKGROUND_PROMPTS.map((_, i) => res.vectors.slice((off + i) * dim, (off + i + 1) * dim));
      }
    }
    return texts.map((t) => prepareVisionTopic(t, this.topics.get(t)!, this.background!));
  }

  // ── Workers ─────────────────────────────────────────────────────────────

  private ensureReady(): Promise<boolean> {
    if (this.failedAt !== null && this.deps.now() - this.failedAt >= RECOVERY_COOLDOWN_MS) {
      this.failedAt = null;
      this.restarts = 0;
      this.ready = null;
    }
    this.ready ??= this.start();
    return this.ready;
  }

  /** Start the image worker (and load the precomputed background alongside). */
  private async start(): Promise<boolean> {
    const epoch = this.epoch;
    this.setStatus({ state: "loading", backend: null, detail: null });
    try {
      const [{ loadMs, threads }] = await Promise.all([this.spawn("image"), this.loadBackground(epoch)]);
      // Shut down meanwhile: the new worker was already terminated; report nothing.
      if (epoch !== this.epoch) return false;
      this.setStatus({ state: "ready", backend: "cpu", threads, loadMs, detail: this.restarts ? `restarted ${this.restarts}×` : null });
      return true;
    } catch (err) {
      if (epoch !== this.epoch) return false;
      this.stopWorker("image");
      this.failedAt = this.deps.now();
      this.setStatus({ state: "error", backend: null, detail: errorText(err) });
      return false;
    }
  }

  private async loadBackground(epoch: number): Promise<void> {
    if (this.background || !this.deps.loadBackground) return;
    const vectors = usableBackground(await this.deps.loadBackground().catch(() => null));
    if (epoch !== this.epoch) return;
    this.stats.backgroundPrecomputed = vectors !== null;
    if (vectors) this.background = vectors;
  }

  private ensureTextWorker(): Promise<void> {
    if (this.textIdle !== null) clearTimeout(this.textIdle);
    this.textIdle = null;
    this.textReady ??= this.spawn("text").then(
      () => {
        this.stats.textWorkerStarts++;
      },
      (err) => {
        this.stopWorker("text");
        this.textReady = null;
        throw new Skip("unavailable", `text encoder failed to load: ${errorText(err)}`);
      }
    );
    return this.textReady;
  }

  private scheduleTextIdle(): void {
    if (this.textIdle !== null) clearTimeout(this.textIdle);
    this.textIdle = setTimeout(() => {
      this.textIdle = null;
      // Never while a request is waiting for it.
      if ([...this.pending.values()].some((p) => p.role === "text")) return this.scheduleTextIdle();
      this.stopWorker("text");
    }, this.textIdleMs);
  }

  /** Create and initialise a worker for `role`; resolves with its load time and thread count. */
  private spawn(role: Role): Promise<{ loadMs: number; threads: number }> {
    const worker = this.deps.createWorker();
    this.workers[role] = worker;
    return new Promise<{ loadMs: number; threads: number }>((resolve, reject) => {
      const settle = (err: Error | null, loaded = { loadMs: 0, threads: 1 }) => {
        clearTimeout(timer);
        if (this.initAborts[role] === abort) delete this.initAborts[role];
        if (err) reject(err);
        else resolve(loaded);
      };
      // stopWorker() (shutdown, crash) ends an initialisation still in progress.
      const abort = (err: Error) => settle(err);
      this.initAborts[role] = abort;
      const timer = setTimeout(() => settle(new Error(`${role} model initialisation timed out after ${this.initTimeoutMs} ms`)), this.initTimeoutMs);
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "ready") {
          worker.onmessage = (e) => this.onWorkerMessage(e.data);
          worker.onerror = (e) => this.onWorkerCrash(role, new Error(e.message || `${role} worker crashed`));
          settle(null, { loadMs: m.loadMs, threads: m.threads ?? 1 });
        } else if (m.type === "init-failed") {
          settle(new Error(m.error));
        }
      };
      worker.onerror = (ev) => settle(new Error(ev.message || `${role} worker crashed`));
      worker.postMessage({
        type: "init",
        role,
        ortPrefix: this.deps.assetUrl("vision/"),
        threads: (role === "image" ? this.deps.threads : this.deps.textThreads) ?? 1,
        modelUrl: this.deps.assetUrl(role === "image" ? "vision/vision_model_quantized.onnx" : "vision/text_model_quantized.onnx"),
        tokenizerUrl: role === "text" ? this.deps.assetUrl("vision/tokenizer.json") : undefined,
      });
    });
  }

  private call(role: Role, req: VisionWorkerRequest, transfer: Transferable[] = []): Promise<VisionWorkerResponse> {
    const worker = this.workers[role];
    if (!worker) return Promise.reject(new Skip("unavailable", `${role} model not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Skip("inference", `${role} model did not answer within ${this.jobTimeoutMs} ms`));
        // A stuck worker cannot be trusted with the next job.
        this.onWorkerCrash(role, new Error("timeout"));
      }, this.jobTimeoutMs);
      this.pending.set(id, { role, resolve, reject, timer });
      worker.postMessage({ ...req, id } as VisionWorkerRequest, transfer);
    });
  }

  private onWorkerMessage(msg: VisionWorkerResponse): void {
    if (!("id" in msg)) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  /** Crash or hang. Text: the next topic starts a new worker. Image: restart, or give up after MAX_RESTARTS. */
  private onWorkerCrash(role: Role, err: Error): void {
    this.stopWorker(role, err);
    if (role === "text") return;
    if (this.restarts < MAX_RESTARTS) {
      this.restarts++;
      this.ready = null;
      this.setStatus({ state: "idle", detail: `image worker failed (${err.message}); restarting` });
    } else {
      this.failedAt = this.deps.now();
      this.ready = Promise.resolve(false);
      this.setStatus({ state: "error", backend: null, detail: `image worker failed repeatedly: ${err.message}` });
    }
  }

  private stopWorker(role: Role, err: Error = new Error(`${role} worker stopped`)): void {
    this.initAborts[role]?.(err);
    const worker = this.workers[role];
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      this.workers[role] = null;
    }
    if (role === "text") {
      this.textReady = null;
      if (this.textIdle !== null) clearTimeout(this.textIdle);
      this.textIdle = null;
    }
    for (const [id, p] of this.pending) {
      if (p.role !== role) continue;
      clearTimeout(p.timer);
      p.reject(new Skip("inference", err.message));
      this.pending.delete(id);
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
