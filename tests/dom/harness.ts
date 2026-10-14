// Bundled into the test page: exposes the production controller with a
// scripted classifier so tests decide when and how each request resolves.
import type { ClassifyReply, ClassifyRequest } from "../../src/shared/protocol.ts";
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

const controller = new FilterController({
  doc: document,
  rootMargin: "0px",
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
    decisions: p.req.texts.map((t) => ({ matched: t.includes(needle), topicId: t.includes(needle) ? "t1" : null, score: 0.9, via: "semantic" as const })),
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
        decisions: p.req.texts.map((t) => ({ matched: t.includes(needle), topicId: "t1", score: 0.9, via: "semantic" as const })),
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
  },
});
