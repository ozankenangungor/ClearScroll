/**
 * EngineHost — owns the engine worker and schedules classification jobs.
 *
 * Concurrency model:
 *  - Jobs are processed strictly FIFO, one at a time. Each job carries its
 *    own immutable config snapshot (mode + topics), so there is no shared
 *    "current target" that a later message could change mid-computation.
 *  - Per frame, only the newest generation matters: queued jobs from an
 *    older generation are answered `stale` without running inference.
 *  - The worker processes one embed at a time; requests are correlated by id.
 *
 * Failure model:
 *  - Backends are tried in order (WebGPU if an adapter exists, then CPU).
 *    A backend that fails to initialise, times out or fails at runtime
 *    (e.g. GPU device loss) is abandoned: the worker is terminated and the
 *    next backend is started. The last backend (CPU) is restarted up to
 *    MAX_RESTARTS times after runtime failures, since those are often
 *    transient (a timeout on an overloaded machine). When nothing works, the
 *    host degrades to lexical-only decisions, reports `lexical-fallback`
 *    truthfully, and tries again after RECOVERY_COOLDOWN_MS.
 *  - The job that hit a runtime failure is retried on each backend that
 *    fail-over brings up, so it ends with embeddings from one working
 *    backend, in lexical fallback together with the engine, or — only if
 *    its attempt budget runs out first — with an explicit error.
 */

const MAX_RESTARTS = 2;
/**
 * Embedding attempts per job. Every failed attempt retires one backend
 * instance from a finite pool (the remaining backends, then MAX_RESTARTS
 * restarts of the last one) and fail-over degrades once the pool is empty,
 * so with both backends a job makes at most 2 + MAX_RESTARTS attempts. The
 * cap makes termination explicit rather than a consequence of that pool.
 */
const MAX_EMBED_ATTEMPTS = 2 + MAX_RESTARTS;
const RECOVERY_COOLDOWN_MS = 5 * 60_000;
/** Frames tracked for stale-job dropping; oldest are forgotten first. */
const MAX_TRACKED_FRAMES = 1000;

import { decide, LEXICAL_PARAMS, prepareTopic, type Background, type Decision, type ModeParams } from "../shared/classifier.ts";
import { applyTopicTemplate, BACKGROUND_TOPICS, MIN_SEMANTIC_CHARS, MODEL_PROFILES, type ModelProfile } from "../shared/models.ts";
import type {
  Backend,
  ClassifyReply,
  EngineStats,
  EngineStatus,
  OffscreenClassify,
  WorkerRequest,
  WorkerResponse,
} from "../shared/protocol.ts";
import type { FilterMode } from "../shared/settings.ts";
import { LruCache } from "./lru.ts";

export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

export interface EngineHostDeps {
  createWorker(): WorkerLike;
  /** Resolve a path inside the extension package to a URL. */
  assetUrl(path: string): string;
  /** Backends to try, in order. Empty → lexical only. */
  backends(): Promise<Backend[]>;
  /** Optional note explaining skipped backends (shown in diagnostics). */
  backendNote?(): string | null;
  /** Fetch model metadata (model/model.json). */
  loadModelMeta(): Promise<ModelMeta>;
  onStatus(status: EngineStatus): void;
  now(): number;
  initTimeoutMs?: number;
  embedTimeoutMs?: number;
  cacheSize?: number;
  maxEmbedAttempts?: number;
}

export interface ModelMeta {
  id: string;
  /** Reference embeddings computed by PyTorch at export time. */
  selftest: { texts: string[]; embeddings: number[][]; max_abs_tol: number };
  /** Precomputed background-topic embeddings (optional; see classifier.ts). */
  background?: { topics: string[]; embeddings: number[][] };
}

interface Job {
  msg: OffscreenClassify;
  resolve(reply: ClassifyReply): void;
}

interface PendingEmbed {
  resolve(vectors: Float32Array): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class EngineHost {
  private status: EngineStatus;
  private worker: WorkerLike | null = null;
  private dim = 0;
  private profile: ModelProfile | null = null;
  private meta: ModelMeta | null = null;
  private background: Background | null = null;
  /** The background vectors were computed by the current worker (not model.json). */
  private backgroundFromWorker = false;
  private remainingBackends: Backend[] | null = null;
  private ready: Promise<boolean> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingEmbed>();
  private readonly queue: Job[] = [];
  private running = false;
  private readonly latestGeneration = new LruCache<string, number>(MAX_TRACKED_FRAMES);
  private restarts: Partial<Record<Backend, number>> = {};
  /** Set when degraded after trying real backends (not when disabled by preference). */
  private degradedAt: number | null = null;
  private readonly cache: LruCache<string, Float32Array>;
  private readonly initTimeoutMs: number;
  private readonly embedTimeoutMs: number;
  private readonly maxEmbedAttempts: number;

  /** Counters for diagnostics and the benchmark harness. */
  readonly stats: EngineStats = { jobs: 0, staleDropped: 0, embedded: 0, cacheHits: 0, embedMs: 0, canaryFailures: 0, wasmMemoryBytes: null, wasmMemoryBeforeModelBytes: null };

  private readonly deps: EngineHostDeps;

  constructor(deps: EngineHostDeps) {
    this.deps = deps;
    this.status = { state: "idle", backend: null, model: "unknown", detail: null, loadMs: null, updatedAt: deps.now() };
    this.initTimeoutMs = deps.initTimeoutMs ?? 120_000;
    this.embedTimeoutMs = deps.embedTimeoutMs ?? 60_000;
    this.maxEmbedAttempts = deps.maxEmbedAttempts ?? MAX_EMBED_ATTEMPTS;
    this.cache = new LruCache(deps.cacheSize ?? 4000);
  }

  getStatus(): EngineStatus {
    return this.status;
  }

  private setStatus(patch: Partial<EngineStatus>): void {
    this.status = { ...this.status, ...patch, updatedAt: this.deps.now() };
    this.deps.onStatus(this.status);
  }

  classify(msg: OffscreenClassify): Promise<ClassifyReply> {
    const prev = this.latestGeneration.get(msg.frameKey) ?? -Infinity;
    if (msg.generation > prev) this.latestGeneration.set(msg.frameKey, msg.generation);
    return new Promise((resolve) => {
      this.queue.push({ msg, resolve });
      void this.pump();
    });
  }

  /** Number of frames whose latest generation is remembered (bounded). */
  trackedFrames(): number {
    return this.latestGeneration.size;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        const latest = this.latestGeneration.get(job.msg.frameKey) ?? job.msg.generation;
        if (job.msg.generation < latest) {
          this.stats.staleDropped++;
          job.resolve({ ok: false, generation: job.msg.generation, error: "stale", stale: true, engine: this.status });
          continue;
        }
        job.resolve(await this.run(job.msg));
      }
    } finally {
      this.running = false;
    }
  }

  private params(mode: FilterMode): ModeParams {
    const threshold = this.profile ? this.profile.thresholds[mode] : Infinity;
    return { threshold, minSemanticChars: MIN_SEMANTIC_CHARS[mode], lexical: LEXICAL_PARAMS[mode] };
  }

  private async run(msg: OffscreenClassify): Promise<ClassifyReply> {
    this.stats.jobs++;
    const keys = [...msg.topics.map((t) => topicKey(t.text)), ...msg.texts.map(textKey)];
    let semantic = await this.ensureReady();
    let vectors: Map<string, Float32Array> | null = null;
    // Retry on each backend that fail-over brings up until the job has its
    // embeddings, the engine degrades (semantic = false) or the budget is spent.
    for (let attempt = 1; semantic && !vectors; attempt++) {
      try {
        vectors = await this.embedCached(keys);
      } catch (err) {
        // Runtime failure (device lost, worker crash, timeout, canary): move to
        // the next backend, or restart the last one.
        semantic = await this.failOver(`runtime failure: ${errorText(err)}`);
        if (semantic && attempt >= this.maxEmbedAttempts) {
          // The engine recovered but this job has no embeddings: a retryable
          // error, not keyword verdicts under a "semantic" engine status.
          return { ok: false, generation: msg.generation, error: `semantic inference failed after ${attempt} attempt${attempt === 1 ? "" : "s"}`, engine: this.status };
        }
      }
    }
    // From here, vectors !== null exactly when the engine is semantic.

    const params = this.params(msg.mode);
    const background = vectors && this.profile?.scoring === "margin" ? this.background : null;
    const topics = msg.topics.map((t) =>
      prepareTopic(t, vectors?.get(topicKey(t.text)) ?? null, params, background)
    );
    let flat: Float32Array | null = null;
    if (vectors) {
      flat = new Float32Array(msg.texts.length * this.dim);
      msg.texts.forEach((t, i) => flat!.set(vectors!.get(textKey(t))!, i * this.dim));
    }
    let decisions: Decision[];
    try {
      decisions = decide(msg.texts, flat, this.dim, topics, params, background);
    } catch (err) {
      return { ok: false, generation: msg.generation, error: errorText(err), engine: this.status };
    }
    return { ok: true, generation: msg.generation, decisions, engine: this.status };
  }

  private async embedCached(keys: string[]): Promise<Map<string, Float32Array>> {
    const out = new Map<string, Float32Array>();
    const missing: string[] = [];
    for (const k of keys) {
      if (out.has(k)) continue;
      const hit = this.cache.get(k);
      if (hit) {
        this.stats.cacheHits++;
        out.set(k, hit);
      } else if (!missing.includes(k)) {
        missing.push(k);
      }
    }
    if (missing.length > 0) {
      const flat = await this.embed(missing.map((k) => k.slice(2)));
      missing.forEach((k, i) => {
        const v = flat.slice(i * this.dim, (i + 1) * this.dim);
        this.cache.set(k, v);
        out.set(k, v);
      });
      this.stats.embedded += missing.length;
    }
    return out;
  }

  /**
   * Embed via the worker. On the GPU backend every batch carries a canary —
   * a self-test sentence with a known reference embedding — and the batch is
   * rejected if the canary comes back wrong. This catches GPU failures that
   * still "succeed" (lost devices, broken drivers or emulators returning
   * stale or NaN buffers); the caller then fails over to the CPU backend.
   */
  private async embed(texts: string[]): Promise<Float32Array> {
    const canary = this.status.backend === "webgpu" && this.meta ? this.meta.selftest : null;
    const batch = canary ? [...texts, canary.texts[0]!] : texts;
    const flat = await this.embedRaw(batch);
    if (!canary) return flat;
    const ref = canary.embeddings[0]!;
    const off = texts.length * this.dim;
    for (let j = 0; j < this.dim; j++) {
      const d = Math.abs(flat[off + j]! - ref[j]!);
      if (!(d <= canary.max_abs_tol)) {
        this.stats.canaryFailures++;
        throw new Error(`GPU canary mismatch (|Δ| ${Number.isNaN(d) ? "NaN" : d.toExponential(2)})`);
      }
    }
    return flat.subarray(0, off);
  }

  private embedRaw(texts: string[]): Promise<Float32Array> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("no worker"));
    const id = this.nextId++;
    const start = this.deps.now();
    return new Promise<Float32Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`embedding timed out after ${this.embedTimeoutMs} ms`));
      }, this.embedTimeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          this.stats.embedMs += this.deps.now() - start;
          if (v.length !== texts.length * this.dim) {
            reject(new Error(`worker returned ${v.length} values for ${texts.length} texts`));
          } else {
            resolve(v);
          }
        },
        reject,
        timer,
      });
      worker.postMessage({ type: "embed", id, texts });
    });
  }

  private ensureReady(): Promise<boolean> {
    if (this.degradedAt !== null && this.deps.now() - this.degradedAt >= RECOVERY_COOLDOWN_MS) {
      this.degradedAt = null;
      this.restarts = {};
      this.ready = null;
    }
    this.ready ??= this.initialise();
    return this.ready;
  }

  private async initialise(): Promise<boolean> {
    this.setStatus({ state: "loading", detail: null });
    try {
      const meta = await this.deps.loadModelMeta();
      const profile = MODEL_PROFILES[meta.id];
      if (!profile) throw new Error(`no calibrated profile for model "${meta.id}"`);
      this.profile = profile;
      this.meta = meta;
      this.setStatus({ model: meta.id });
      this.remainingBackends = await this.deps.backends();
    } catch (err) {
      this.remainingBackends = [];
      return this.degrade(errorText(err), false);
    }
    return this.startNextBackend([]);
  }

  private async startNextBackend(errors: string[]): Promise<boolean> {
    while (this.remainingBackends && this.remainingBackends.length > 0) {
      const backend = this.remainingBackends.shift()!;
      this.setStatus({ state: "loading", backend, detail: null });
      try {
        const { dim, loadMs } = await this.startWorker(backend);
        this.dim = dim;
        await this.selfTest();
        await this.loadBackground();
        const notes = [...errors];
        const note = this.deps.backendNote?.();
        if (note && backend !== "webgpu") notes.unshift(note);
        this.setStatus({ state: "semantic", backend, loadMs, detail: notes.length ? notes.join("; ") : null });
        return true;
      } catch (err) {
        errors.push(`${backend}: ${errorText(err)}`);
        this.stopWorker();
      }
    }
    // Recoverable only if real backends were tried (not "engine: off").
    return this.degrade(errors.join("; ") || "no inference backend available", errors.length > 0);
  }

  /**
   * Embed the reference sentences and compare with PyTorch's output. A
   * backend that initialises but computes wrong numbers (seen with Chrome's
   * SwiftShader WebGPU emulation, which returns NaN) is rejected here instead
   * of being reported as a working semantic engine.
   */
  private async selfTest(): Promise<void> {
    const { texts, embeddings, max_abs_tol } = this.meta!.selftest;
    const got = await this.embedRaw(texts);
    let worst = 0;
    embeddings.forEach((ref, i) => {
      if (ref.length !== this.dim) throw new Error(`self-test: expected dim ${ref.length}, engine has ${this.dim}`);
      ref.forEach((v, j) => {
        const d = Math.abs(got[i * this.dim + j]! - v);
        worst = Number.isNaN(d) ? Infinity : Math.max(worst, d);
      });
    });
    if (!(worst <= max_abs_tol)) {
      throw new Error(`self-test failed: max |Δ| ${worst === Infinity ? "NaN" : worst.toExponential(2)} > ${max_abs_tol}`);
    }
  }

  /**
   * Background topics for margin scoring. Precomputed vectors from
   * model.json are used when they describe exactly BACKGROUND_TOPICS for
   * this model's dimension; otherwise they are embedded once on this backend.
   * Thresholds are calibrated with margin scoring, so there is no fallback to
   * scoring without a background.
   */
  private async loadBackground(): Promise<void> {
    if (this.background || this.profile?.scoring !== "margin") return;
    const pre = this.meta?.background;
    const usable =
      pre &&
      pre.topics.length === BACKGROUND_TOPICS.length &&
      pre.topics.every((t, i) => t === BACKGROUND_TOPICS[i]) &&
      pre.embeddings.length === pre.topics.length &&
      pre.embeddings.every((e) => e.length === this.dim && e.every(Number.isFinite));
    const vectors = usable
      ? Float32Array.from(pre.embeddings.flat())
      : // Background phrases are never templated (prepare_model.py embeds them verbatim).
        await this.embedRaw([...BACKGROUND_TOPICS]);
    this.background = { vectors, count: BACKGROUND_TOPICS.length };
    this.backgroundFromWorker = !usable;
  }

  private degrade(detail: string, recoverable: boolean): boolean {
    this.degradedAt = recoverable ? this.deps.now() : null;
    this.setStatus({ state: "lexical-fallback", backend: null, detail });
    return false;
  }

  private async failOver(reason: string): Promise<boolean> {
    const failed = this.status.backend;
    this.stopWorker();
    // Nothing computed by the failed worker is reused by its replacement.
    this.cache.clear();
    if (this.backgroundFromWorker) {
      this.background = null;
      this.backgroundFromWorker = false;
    }
    // Prefer the next backend; if this was the last one, restart it a few times.
    if (failed && this.remainingBackends?.length === 0 && (this.restarts[failed] ?? 0) < MAX_RESTARTS) {
      this.restarts[failed] = (this.restarts[failed] ?? 0) + 1;
      this.remainingBackends.push(failed);
    }
    this.ready = this.startNextBackend([`${failed ?? "engine"}: ${reason}`]);
    return this.ready;
  }

  private startWorker(backend: Backend): Promise<{ dim: number; loadMs: number }> {
    const worker = this.deps.createWorker();
    this.worker = worker;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`initialisation timed out after ${this.initTimeoutMs} ms`)), this.initTimeoutMs);
      const finish = (err: Error | null, value?: { dim: number; loadMs: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value!);
      };
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === "ready") {
          this.stats.wasmMemoryBytes = msg.wasmMemoryBytes;
          this.stats.wasmMemoryBeforeModelBytes = msg.wasmMemoryBeforeModelBytes;
          finish(null, { dim: msg.dim, loadMs: msg.loadMs });
        }
        else if (msg.type === "init-failed") finish(new Error(msg.error));
        else this.onWorkerMessage(msg);
      };
      worker.onerror = (ev) => {
        const err = new Error(ev.message || "worker crashed");
        finish(err);
        this.rejectAllPending(err);
      };
      worker.postMessage({
        type: "init",
        backend,
        wasmUrl: this.deps.assetUrl("pkg/clearscroll_engine_bg.wasm"),
        weightsUrl: this.deps.assetUrl("model/weights.bin"),
        vocabUrl: this.deps.assetUrl("model/vocab.txt"),
      });
    });
  }

  private onWorkerMessage(msg: WorkerResponse): void {
    if (msg.type !== "embedded" && msg.type !== "embed-failed") return;
    const p = this.pending.get(msg.id);
    if (!p) return; // timed out earlier; result is dropped
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === "embedded") {
      this.stats.wasmMemoryBytes = msg.wasmMemoryBytes;
      p.resolve(msg.vectors);
    }
    else p.reject(new Error(msg.error));
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private stopWorker(): void {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.rejectAllPending(new Error("worker stopped"));
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cache keys distinguish topic queries (templated) from page texts. */
function topicKey(text: string): string {
  return `q:${applyTopicTemplate(text)}`;
}

function textKey(text: string): string {
  return `t:${text}`;
}
