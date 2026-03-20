// Bundled into the test page: exposes the production controller with a
// scripted classifier so tests decide when and how each request resolves.
import type { ClassifyReply, ClassifyRequest } from "../../src/shared/protocol.ts";
import type { SkipReason, VisionReply, VisionRequest } from "../../src/shared/vision.ts";
import { base64ToBytes } from "../../src/vision/preprocess.ts";
import { defaultSettings, type Settings } from "../../src/shared/settings.ts";
import { FilterController } from "../../src/content/controller.ts";

interface Pending {
  req: ClassifyRequest;
  resolve(r: ClassifyReply): void;
  reject(e: unknown): void;
}

const pending: Pending[] = [];
const log: ClassifyRequest[] = [];
let invalidated = 0;

// ── Scripted image classifier ─────────────────────────────────────────────
// Decides from the pixels it receives: a frame whose centre pixel is mostly
// red "matches". URL requests (downloads) match when the URL contains MATCH.
// "auto" answers at once; "manual" holds requests until the test answers.
interface ImagePending {
  req: VisionRequest;
  resolve(r: VisionReply): void;
}
const imagePending: ImagePending[] = [];
const imageLog: { generation: number; kind: string; url?: string; red?: boolean }[] = [];
let imageMode: "auto" | "manual" = "auto";
let imageInflightMax = 0;
let imageInflight = 0;

function isRed(req: VisionRequest): boolean {
  if (req.image.kind === "url") return req.image.url.includes("MATCH");
  const rgb = base64ToBytes(req.image.rgb);
  const i = (112 * 224 + 112) * 3;
  return rgb[i]! > 180 && rgb[i + 1]! < 80 && rgb[i + 2]! < 80;
}

function imageReply(req: VisionRequest, matched = isRed(req)): VisionReply {
  return { ok: true, generation: req.generation, decision: { matched, topicId: matched ? req.topics[0]!.id : null, score: matched ? 0.05 : -0.05 }, vision: { state: "ready", backend: "cpu", model: "test", detail: null, loadMs: 1, updatedAt: Date.now() } };
}

function classifyImage(req: VisionRequest): Promise<VisionReply> {
  imageLog.push({ generation: req.generation, kind: req.image.kind, url: req.image.kind === "url" ? req.image.url : undefined, red: isRed(req) });
  imageInflight++;
  imageInflightMax = Math.max(imageInflightMax, imageInflight);
  return new Promise<VisionReply>((resolve) => {
    const done = (r: VisionReply) => {
      imageInflight--;
      resolve(r);
    };
    if (imageMode === "auto") setTimeout(() => done(imageReply(req)), 5);
    else imagePending.push({ req, resolve: done });
  });
}

const controller = new FilterController({
  doc: document,
  rootMargin: "0px",
  imageRootMargin: "0px",
  classifyImage,
  classify: (req) =>
    new Promise<ClassifyReply>((resolve, reject) => {
      log.push(req);
      pending.push({ req, resolve, reject });
    }),
  onInvalidated: () => invalidated++,
});

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), topics: [{ id: "t1", text: "crypto", enabled: true }], ...patch };
}

/** Resolve pending request #i: texts containing `needle` match. */
function respond(i: number, needle = "MATCH", generation?: number): void {
  const [p] = pending.splice(i, 1);
  if (!p) throw new Error(`no pending request #${i} (have ${pending.length})`);
  p.resolve({
    ok: true,
    generation: generation ?? p.req.generation,
    decisions: p.req.texts.map((t) => ({ matched: t.includes(needle), topicId: t.includes(needle) ? "t1" : null, score: 0.9, similarity: 0.9, via: "semantic" as const })),
    engine: { state: "semantic", backend: "cpu", model: "test", detail: null, loadMs: 1, updatedAt: Date.now() },
  });
}

/** Resolve pending request #i with an error reply (engine-side failure). */
function respondError(i: number, error = "engine exploded", stale = false): void {
  const [p] = pending.splice(i, 1);
  p!.resolve({ ok: false, generation: p!.req.generation, error, stale, engine: null });
}

function fail(i: number, err: unknown): void {
  const [p] = pending.splice(i, 1);
  p!.reject(err);
}

/** A second, independent controller on the same document (e.g. the content
 * script of an updated extension next to the orphaned old one). */
const extraPending: Pending[] = [];
let second: FilterController | null = null;
function createSecond(): void {
  second = new FilterController({
    doc: document,
    rootMargin: "0px",
    classify: (req) => new Promise<ClassifyReply>((resolve, reject) => extraPending.push({ req, resolve, reject })),
  });
}

Object.assign(window, {
  harness: {
    createSecond,
    applySecond: (patch: Partial<Settings> = {}) => second!.applySettings(settings(patch), "https://example.test/page"),
    respondSecond: (needle = "MATCH") => {
      const p = extraPending.shift()!;
      p.resolve({
        ok: true,
        generation: p.req.generation,
        decisions: p.req.texts.map((t) => ({ matched: t.includes(needle), topicId: "t1", score: 0.9, similarity: 0.9, via: "semantic" as const })),
        engine: null as never,
      });
    },
    secondPendingCount: () => extraPending.length,
    controller,
    settings,
    apply: (patch: Partial<Settings> = {}, url = "https://example.test/page") => controller.applySettings(settings(patch), url),
    respond,
    fail,
    respondError,
    pendingCount: () => pending.length,
    pendingTexts: () => pending.map((p) => p.req.texts),
    pendingGenerations: () => pending.map((p) => p.req.generation),
    log: () => log.map((r) => ({ generation: r.generation, texts: r.texts, topics: r.topics.map((t) => t.text), mode: r.mode })),
    invalidated: () => invalidated,
    state: () => controller.getState(),
    // Images
    setImageMode: (m: "auto" | "manual") => (imageMode = m),
    imageLog: () => imageLog,
    imagePendingCount: () => imagePending.length,
    imageInflightMax: () => imageInflightMax,
    /** Answer pending image request #i (by default from its pixels). */
    respondImage: (i = 0, matched?: boolean, generation?: number) => {
      const [p] = imagePending.splice(i, 1);
      if (!p) throw new Error(`no pending image request #${i}`);
      const r = imageReply(p.req, matched);
      p.resolve(generation === undefined ? r : { ...r, generation });
    },
    failImage: (i = 0, reason: SkipReason = "unavailable") => {
      const [p] = imagePending.splice(i, 1);
      p!.resolve({ ok: false, generation: p!.req.generation, reason, error: reason, vision: null });
    },
    /** A solid-colour PNG data URL (w × h). */
    solid: (color: string, w = 320, h = 240) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, w, h);
      return c.toDataURL("image/png");
    },
  },
});
