/**
 * Cross-component ordering tests: the service worker's VisionGate (real
 * code) wired to the offscreen VisionHost (real code; scripted model worker),
 * with every step that can be delayed in the browser under the test's
 * control: offscreen-document creation (ensureOffscreen) and the delivery of
 * each runtime message. Question under test (Task 05.2): can an image request
 * authorised *before* the user withdrew consent restart the image model or
 * start a download *after* it?
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { VisionGate, type UnauthorisedVision } from "../../src/background/vision-gate.ts";
import { VisionHost, type VisionWorkerLike } from "../../src/offscreen/vision-host.ts";
import { defaultSettings, type Settings } from "../../src/shared/settings.ts";
import { isOffscreenVisionMessage, type OffscreenVision, type VisionReply, type VisionWorkerRequest, type VisionWorkerResponse } from "../../src/shared/vision.ts";
import { bytesToBase64, RGB_FRAME_BYTES } from "../../src/vision/preprocess.ts";

// ── Scripted model worker (cats → axis 0) ─────────────────────────────────

class Worker implements VisionWorkerLike {
  onmessage: ((ev: MessageEvent<VisionWorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  role: "image" | "text" | null = null;
  private send(msg: VisionWorkerResponse) {
    setTimeout(() => !this.terminated && this.onmessage?.({ data: msg } as MessageEvent<VisionWorkerResponse>), 0);
  }
  postMessage(msg: VisionWorkerRequest): void {
    if (msg.type === "init") {
      this.role = msg.role;
      this.send({ type: "ready", loadMs: 1 });
    } else if (msg.type === "text") {
      this.send({ type: "text-done", id: msg.id, vectors: Float32Array.from(msg.prompts.flatMap((p) => (/cat/.test(p) ? [1, 0, 0, 0] : [0, 0, 0, 1]))), ms: 1 });
    } else {
      this.send({ type: "image-done", id: msg.id, vector: Float32Array.from(msg.rgb?.[0] === 1 ? [1, 0, 0, 0] : [0, 0, 0, 1]), ms: 1 });
    }
  }
  terminate(): void {
    this.terminated = true;
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

/**
 * The browser around the two components. Offscreen documents are VisionHost
 * instances; closing one discards it (as Chrome does), creating one makes a
 * fresh host. Message delivery to the document can be held per message type.
 */
function world() {
  let settings: Settings = { ...defaultSettings(), topics: [{ id: "c", text: "cats", enabled: true }], images: true, imageDownloads: true };
  const docs: VisionHost[] = [];
  const workers: Worker[] = [];
  const fetches: string[] = [];
  let doc: VisionHost | null = null;
  let now = 1_000;
  /** Set to hold the next ensureOffscreen call until released. */
  let ensureGate: { promise: Promise<void> } | null = null;
  /** Message types whose delivery to the document is held until released. */
  const held = new Map<string, { promise: Promise<void> }>();
  const session = new Map<string, unknown>();

  const newDoc = () => {
    const host = new VisionHost({
      createWorker: () => {
        const w = new Worker();
        workers.push(w);
        return w;
      },
      assetUrl: (p) => p,
      fetch: (async (url: string) => {
        fetches.push(url);
        return new Response("x", { headers: { "content-type": "image/jpeg" } });
      }) as typeof fetch,
      onStatus: () => undefined,
      now: () => now,
      sha256: async (s) => `${s.length}:${s.slice(0, 32)}`,
    });
    docs.push(host);
    return host;
  };

  /** The offscreen document's runtime.onMessage handler (offscreen.ts). */
  const deliver = async (msg: unknown): Promise<unknown> => {
    const type = (msg as { type: string }).type;
    const h = held.get(type);
    if (h) await h.promise;
    if (!doc) throw new Error("Could not establish connection. Receiving end does not exist.");
    if (!isOffscreenVisionMessage(msg)) throw new Error(`invalid message ${type}`);
    if (msg.type === "off:vision") return doc.classify(msg);
    if (msg.type === "off:vision-shutdown") {
      doc.shutdown((msg as { revokedAt?: number }).revokedAt);
      return doc.getStatus();
    }
    if (msg.type === "off:vision-revoke-downloads") {
      doc.revokeDownloads(msg.revokedAt);
      return doc.getStatus();
    }
    return doc.getStatus();
  };

  const gate = new VisionGate({
    loadSettings: async () => settings,
    // background.ts's ensureOffscreen: serialised create-if-missing; with a
    // still-allowed check (if the gate passes one) right before creating.
    ensureOffscreen: (async (_s: Settings, stillAllowed?: () => boolean) => {
      if (ensureGate) await ensureGate.promise;
      if (stillAllowed && !stillAllowed()) return false;
      doc ??= newDoc();
      return true;
    }) as (s: Settings, stillAllowed: () => boolean) => Promise<boolean>,
    offscreenExists: async () => doc !== null,
    send: deliver,
    sessionGet: async (k) => (session.has(k) ? { [k]: session.get(k) } : {}),
    sessionSet: async (items) => {
      for (const [k, v] of Object.entries(items)) session.set(k, v);
    },
    now: () => (now += 1),
    retryDelayMs: 1,
  });

  return {
    gate,
    docs,
    workers,
    fetches,
    get doc() {
      return doc;
    },
    /** The user changes settings: storage.onChanged in the service worker. */
    change(patch: Partial<Settings>) {
      const prev = settings;
      settings = { ...settings, ...patch };
      gate.settingsChanged(prev, settings);
    },
    /** background.ts's sync closing the document when filtering is inactive. */
    closeDoc() {
      doc = null;
    },
    holdEnsure() {
      const d = deferred();
      ensureGate = d;
      return () => {
        ensureGate = null;
        d.resolve();
      };
    },
    holdDelivery(type: string) {
      const d = deferred();
      held.set(type, d);
      return () => {
        held.delete(type);
        d.resolve();
      };
    },
    liveWorkers: () => workers.filter((w) => !w.terminated).length,
  };
}

const frame = (cat: boolean) => {
  const f = new Uint8Array(RGB_FRAME_BYTES);
  f[0] = cat ? 1 : 2;
  f[1] = Math.floor(Math.random() * 256);
  return bytesToBase64(f);
};

let gen = 0;
const request = (image: OffscreenVision["image"]): UnauthorisedVision => ({
  type: "off:vision",
  target: "offscreen",
  frameKey: "1:0:doc",
  generation: ++gen,
  mode: "balanced",
  topics: [{ id: "c", text: "cats" }],
  image,
});
const pixels = () => request({ kind: "pixels", rgb: frame(true) });
const PAGE = "https://example.com/feed";

function outcome(r: VisionReply): string {
  return r.ok ? (r.decision.matched ? "matched" : "not-matched") : r.reason;
}

test("baseline: an authorised image request loads the model and is classified", async () => {
  const w = world();
  assert.equal(outcome(await w.gate.forward(pixels(), PAGE)), "matched");
  assert.equal(w.liveWorkers(), 2, "image + text worker");
});

test("late request: authorised, delayed in ensureOffscreen, delivered after images were turned off → model not restarted", async () => {
  const w = world();
  assert.equal(outcome(await w.gate.forward(pixels(), PAGE)), "matched"); // model loaded
  const release = w.holdEnsure();
  const late = w.gate.forward(pixels(), PAGE); // passes the settings check, then waits
  await tick();
  w.change({ images: false }); // storage.onChanged → shutdown message
  await tick();
  assert.equal(w.liveWorkers(), 0, "shutdown terminated the workers");
  assert.equal(w.doc!.getStatus().state, "idle");
  const before = w.workers.length;
  release();
  const r = await late;
  await tick();
  assert.equal(w.workers.length, before, "no worker started after image filtering was turned off");
  assert.equal(w.doc!.getStatus().state, "idle", "image model not resurrected");
  assert.equal(outcome(r), "disabled");
});

test("late request: forwarded before the change but delivered after the shutdown message → refused by the host", async () => {
  const w = world();
  assert.equal(outcome(await w.gate.forward(pixels(), PAGE)), "matched");
  const release = w.holdDelivery("off:vision");
  const late = w.gate.forward(pixels(), PAGE);
  await tick();
  w.change({ images: false });
  await tick();
  const before = w.workers.length;
  release();
  const r = await late;
  await tick();
  assert.equal(outcome(r), "disabled");
  assert.equal(w.workers.length, before, "no worker started");
  assert.equal(w.doc!.getStatus().state, "idle");
});

test("late request across a pause (document closed): the offscreen document is not recreated for it", async () => {
  const w = world();
  assert.equal(outcome(await w.gate.forward(pixels(), PAGE)), "matched");
  const release = w.holdEnsure();
  const late = w.gate.forward(pixels(), PAGE);
  await tick();
  w.change({ enabled: false }); // filtering paused …
  w.closeDoc(); // … and the registration sync closes the offscreen document
  release();
  const r = await late;
  await tick();
  assert.equal(outcome(r), "disabled");
  assert.equal(w.doc, null, "no offscreen document was created for a request authorised before the pause");
  assert.equal(w.docs.length, 1);
});

test("rapid disable → re-enable: the old delayed request is refused; a new request after re-enabling works", async () => {
  const w = world();
  assert.equal(outcome(await w.gate.forward(pixels(), PAGE)), "matched");
  const release = w.holdDelivery("off:vision");
  const old = w.gate.forward(pixels(), PAGE);
  await tick();
  w.change({ images: false });
  await tick();
  w.change({ images: true }); // re-enabled before the old message arrives
  release();
  assert.equal(outcome(await old), "disabled", "authorised under the withdrawn consent");
  // Legitimate use after re-enabling: model loads again and classifies.
  assert.equal(outcome(await w.gate.forward(pixels(), PAGE)), "matched");
  assert.equal(w.doc!.getStatus().state, "ready");
});

test("only downloads revoked: a delayed pixel request is still classified; a delayed URL request never downloads", async () => {
  const w = world();
  assert.equal(outcome(await w.gate.forward(pixels(), PAGE)), "matched");
  const release = w.holdEnsure();
  const pix = w.gate.forward(pixels(), PAGE);
  const url = w.gate.forward(request({ kind: "url", url: "https://cdn.example.com/cat.jpg" }), PAGE);
  await tick();
  w.change({ imageDownloads: false });
  await tick();
  release();
  assert.equal(outcome(await pix), "matched", "pixel inference continues");
  assert.equal(outcome(await url), "downloads-off");
  assert.deepEqual(w.fetches, [], "no download after the revocation");
  assert.equal(w.doc!.getStatus().state, "ready", "the image model stays loaded");
});

test("disable while the first-ever request waits: nothing is ever loaded", async () => {
  const w = world();
  const release = w.holdEnsure();
  const late = w.gate.forward(pixels(), PAGE);
  await tick();
  w.change({ images: false });
  release();
  assert.equal(outcome(await late), "disabled");
  assert.equal(w.workers.length, 0, "no model was ever started");
});
