/**
 * Image filtering: preprocessing arithmetic, protocol validation, URL
 * eligibility, the decision rule, settings migration and the offscreen
 * VisionHost (with a scripted worker and fetch). Tokenizer parity with the
 * real model files is in vision-model.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { VisionHost, type VisionHostDeps, type VisionWorkerLike } from "../../src/offscreen/vision-host.ts";
import { defaultSettings, isImageFilteringActive, migrateSettings, normalizeSettings, SETTINGS_KEY } from "../../src/shared/settings.ts";
import {
  BACKGROUND_SYNONYM_COSINE,
  checkImageUrl,
  decideImage,
  isOffscreenVisionMessage,
  isVisionRequest,
  isVisualMatch,
  meanVector,
  prepareVisionTopic,
  topicPrompts,
  VISION_BACKGROUND_PROMPTS,
  VISION_RULES,
  visionScores,
  type OffscreenVision,
  type VisionReply,
  type VisionStatus,
  type VisionWorkerRequest,
  type VisionWorkerResponse,
} from "../../src/shared/vision.ts";
import { base64ToBytes, bytesToBase64, IMAGE_MEAN, IMAGE_STD, INPUT_SIZE, RGB_FRAME_BASE64_CHARS, RGB_FRAME_BYTES, rgbaToRgb, rgbToTensor } from "../../src/vision/preprocess.ts";
import { canonicalizeText } from "../../src/vision/siglip-tokenizer.ts";

// ── Preprocessing ─────────────────────────────────────────────────────────

test("preprocessing: RGBA → RGB drops alpha; tensor is CHW, scaled and normalised to [-1, 1]", () => {
  assert.deepEqual([...rgbaToRgb(new Uint8Array([1, 2, 3, 255, 4, 5, 6, 0]))], [1, 2, 3, 4, 5, 6]);
  assert.throws(() => rgbaToRgb(new Uint8Array(3)));
  const rgb = new Uint8Array(RGB_FRAME_BYTES);
  // pixel 0 = (0, 128, 255), pixel 1 = (255, 255, 255)
  rgb.set([0, 128, 255, 255, 255, 255], 0);
  const t = rgbToTensor(rgb);
  const plane = INPUT_SIZE * INPUT_SIZE;
  assert.equal(t.length, plane * 3);
  const expect = (v: number, c: number) => (v / 255 - IMAGE_MEAN[c]!) / IMAGE_STD[c]!;
  assert.equal(t[0], -1); // R of pixel 0 (channel plane 0)
  assert.ok(Math.abs(t[plane]! - expect(128, 1)) < 1e-6); // G of pixel 0
  assert.equal(t[2 * plane], 1); // B of pixel 0
  assert.equal(t[1], 1); // R of pixel 1
  assert.equal(t[2], -1); // pixel 2 is black
  assert.throws(() => rgbToTensor(new Uint8Array(10)), /expected/);
});

test("preprocessing: base64 transport round-trips a full frame and has the validated length", () => {
  const frame = new Uint8Array(RGB_FRAME_BYTES).map((_, i) => (i * 7919) % 256);
  const b64 = bytesToBase64(frame);
  assert.equal(b64.length, RGB_FRAME_BASE64_CHARS);
  assert.deepEqual(base64ToBytes(b64), frame);
});

test("tokenizer canonicalisation matches SigLIP's (lowercase, ASCII punctuation removed, spaces collapsed)", () => {
  assert.equal(canonicalizeText("  A Photo of   CATS!! "), "a photo of cats");
  assert.equal(canonicalizeText("fast-food & video-games"), "fastfood  videogames".replace("  ", " "));
  assert.equal(canonicalizeText("Bitcoin's ₿"), "bitcoins ₿");
});

// ── Protocol ──────────────────────────────────────────────────────────────

const rgb = bytesToBase64(new Uint8Array(RGB_FRAME_BYTES));
const req = (patch: Record<string, unknown> = {}) => ({ type: "cs:vision", generation: 3, mode: "precision", topics: [{ id: "t", text: "cats" }], image: { kind: "pixels", rgb }, ...patch });

test("protocol: vision requests are validated strictly", () => {
  assert.ok(isVisionRequest(req()));
  assert.ok(isVisionRequest(req({ image: { kind: "url", url: "https://cdn.example.com/a.jpg" } })));
  for (const bad of [
    null,
    req({ type: "cs:classify" }),
    req({ generation: 1.5 }),
    req({ mode: "turbo" }),
    req({ topics: [] }),
    req({ topics: Array.from({ length: 21 }, (_, i) => ({ id: `${i}`, text: "x" })) }),
    req({ topics: [{ id: "t", text: "x".repeat(121) }] }),
    req({ image: { kind: "pixels", rgb: rgb.slice(1) } }),
    req({ image: { kind: "pixels", rgb: "!".repeat(RGB_FRAME_BASE64_CHARS) } }),
    req({ image: { kind: "url", url: "https://x.example/" + "a".repeat(5000) } }),
    req({ image: { kind: "file", path: "/etc/passwd" } }),
  ]) {
    assert.equal(isVisionRequest(bad), false, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.ok(isOffscreenVisionMessage({ ...req(), type: "off:vision", target: "offscreen", frameKey: "1:0:a", visionGrant: 0 }));
  assert.equal(isOffscreenVisionMessage({ ...req(), type: "off:vision", target: "offscreen", visionGrant: 0 }), false, "frameKey required");
  assert.equal(isOffscreenVisionMessage({ ...req(), type: "off:vision", target: "offscreen", frameKey: "1:0:a" }), false, "visionGrant required (set by the service worker)");
  assert.equal(isOffscreenVisionMessage({ ...req(), type: "off:vision", target: "offscreen", frameKey: "1:0:a", visionGrant: "0" }), false);
  assert.ok(isOffscreenVisionMessage({ type: "off:vision-shutdown", target: "offscreen", revokedAt: 5 }));
  assert.equal(isOffscreenVisionMessage({ type: "off:vision-shutdown", target: "offscreen" }), false, "revokedAt required");
  assert.equal(isOffscreenVisionMessage({ type: "off:vision-shutdown", revokedAt: 5 }), false);
});

test("image URLs: only public http(s) hosts are eligible for download", () => {
  const ok = ["https://i.ytimg.com/vi/x/hqdefault.jpg?sqp=1", "http://ichef.bbci.co.uk/a.jpg", "https://cdn.example:8443/a.webp", "https://8.8.8.8/a.png", "https://[2001:4860::8888]/a.png"];
  for (const u of ok) assert.ok(checkImageUrl(u).ok, u);
  const bad = [
    "data:image/png;base64,AAAA",
    "blob:https://x.example/1",
    "file:///etc/passwd",
    "chrome-extension://abc/x.png",
    "ftp://x.example/a.jpg",
    "https://user:pw@x.example/a.jpg",
    "http://localhost/a.jpg",
    "http://app.localhost/a.jpg",
    "http://printer.local/a.jpg",
    "http://intranet/a.jpg",
    "http://wiki.corp/a.jpg",
    "http://127.0.0.1/a.jpg",
    "http://10.1.2.3/a.jpg",
    "http://172.20.0.1/a.jpg",
    "http://192.168.1.1/a.jpg",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/a.jpg",
    "http://0.0.0.0/a.jpg",
    "http://2130706433/a.jpg",
    "http://0x7f.1/a.jpg",
    "http://[::1]/a.jpg",
    "http://[fd00::1]/a.jpg",
    "http://[fe80::1]/a.jpg",
    "http://[::ffff:127.0.0.1]/a.jpg",
    "not a url",
    "https://x.example/" + "a".repeat(5000),
  ];
  for (const u of bad) assert.equal(checkImageUrl(u).ok, false, u);
});

// ── Decision rule ─────────────────────────────────────────────────────────

const unit = (...v: number[]) => {
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
};

test("decision: an image must beat every generic background description, by the mode's margin", () => {
  // axes: 0 = cat, 1 = animal (generic), 2 = football, 3 = sports (generic)
  const background = [unit(0, 1, 0, 0), unit(0, 0, 0, 1)];
  const cats = prepareVisionTopic("cats", unit(1, 0.3, 0, 0), background);
  assert.equal(cats.background.length, 2, "a supercategory is not a synonym");
  const catPhoto = unit(0.5, 0.3, 0, 0);
  const dogPhoto = unit(0.05, 0.5, 0, 0);
  const s = visionScores(catPhoto, cats);
  assert.ok(s.margin > 0 && isVisualMatch(s, "precision"));
  assert.equal(isVisualMatch(visionScores(dogPhoto, cats), "aggressive"), false, "looks more like 'an animal' than like 'cats'");
  // Exactly at the thresholds: inclusive.
  const r = VISION_RULES.balanced;
  assert.ok(isVisualMatch({ similarity: r.minSimilarity, margin: r.minMargin }, "balanced"));
  assert.equal(isVisualMatch({ similarity: r.minSimilarity - 1e-6, margin: 1 }, "balanced"), false, "similarity floor");
  assert.equal(isVisualMatch({ similarity: 1, margin: r.minMargin - 1e-6 }, "balanced"), false, "margin");
  // Strictness is ordered.
  assert.ok(VISION_RULES.precision.minMargin >= VISION_RULES.balanced.minMargin && VISION_RULES.balanced.minMargin >= VISION_RULES.aggressive.minMargin);
  assert.ok(VISION_RULES.precision.minSimilarity >= VISION_RULES.aggressive.minSimilarity);
});

test("decision: background prompts that are synonyms of the topic are left out for that topic only", () => {
  const animal = unit(0, 1, 0);
  const animals = prepareVisionTopic("animals", unit(0.05, 1, 0), [animal, unit(0, 0, 1)]);
  assert.ok(animals.vector[1]! * animal[1]! >= BACKGROUND_SYNONYM_COSINE);
  assert.equal(animals.background.length, 1);
});

test("decision: decideImage reports the best matching topic, or no topic", () => {
  const background = [unit(0, 0, 1)];
  const a = prepareVisionTopic("a", unit(1, 0, 0), background);
  const b = prepareVisionTopic("b", unit(0.7, 0.7, 0), background);
  const d = decideImage(unit(1, 0.05, 0), [b, a], "precision");
  assert.equal(d.matched, true);
  assert.equal(d.topicId, "a");
  const none = decideImage(unit(0, 0, 1), [a, b], "aggressive");
  assert.deepEqual([none.matched, none.topicId], [false, null]);
  assert.deepEqual(decideImage(unit(1, 0, 0), [], "precision"), { matched: false, topicId: null, score: 0 });
});

test("decision: meanVector averages prompt embeddings and normalises; degenerate input throws", () => {
  const v = meanVector(new Float32Array([1, 0, 0, 1]), 2);
  assert.ok(Math.abs(v[0]! - Math.SQRT1_2) < 1e-6 && Math.abs(v[1]! - Math.SQRT1_2) < 1e-6);
  assert.throws(() => meanVector(new Float32Array([0, 0]), 1));
  assert.equal(topicPrompts("cats").length, 3);
  assert.ok(topicPrompts("$& money").every((p) => p.includes("$& money")), "topic text is inserted literally");
});

// ── Settings ──────────────────────────────────────────────────────────────

test("settings: image filtering and downloads are opt-in, and migrate safely", () => {
  const d = defaultSettings();
  assert.equal(d.images, false);
  assert.equal(d.imageDownloads, false);
  // Existing users' stored settings (written before image filtering existed) keep text-only behaviour.
  const old = { schema: 2, enabled: true, mode: "balanced", engine: "auto", topics: [{ id: "t", text: "crypto", enabled: true }], excludedSites: ["bank.com"], protectedSelectors: [".x"] };
  const m = migrateSettings({ [SETTINGS_KEY]: old });
  assert.equal(m.settings.images, false);
  assert.equal(m.settings.imageDownloads, false);
  assert.deepEqual(m.settings.topics, old.topics);
  assert.deepEqual(m.settings.excludedSites, ["bank.com"]);
  assert.equal(isImageFilteringActive(m.settings), false);
  // Only a literal true enables anything.
  for (const v of ["true", 1, {}, null]) assert.equal(normalizeSettings({ ...old, images: v, imageDownloads: v }).images, false);
  const on = normalizeSettings({ ...old, images: true, imageDownloads: true });
  assert.ok(on.images && on.imageDownloads && isImageFilteringActive(on));
  assert.equal(isImageFilteringActive({ ...on, enabled: false }), false, "paused");
  assert.equal(isImageFilteringActive({ ...on, topics: [] }), false, "no topics");
  // The download preference is kept while image filtering is off (it only applies when on).
  assert.equal(normalizeSettings({ ...old, images: false, imageDownloads: true }).imageDownloads, true);
});

// ── VisionHost ────────────────────────────────────────────────────────────

const DIM = 4;
/** Fake text embedding: "cat" prompts on axis 0, everything else on axis 3. */
function textVec(p: string): number[] {
  return /cat/.test(p) ? [1, 0, 0, 0] : /animal/.test(p) ? [0, 1, 0, 0] : [0, 0, 0, 1];
}

interface WorkerScript {
  initFails?: string;
  initHangs?: boolean;
  /** Crash on this image number, counted across all workers of the host (1-based). */
  crashOnImage?: number;
  /** Crash on every image. */
  alwaysCrash?: boolean;
  hangOnImage?: number;
  /** Shared image counter. */
  seen?: { n: number };
  /** RGB frames whose first byte is 1 are "cats", others "landscape". */
}

class FakeVisionWorker implements VisionWorkerLike {
  onmessage: ((ev: MessageEvent<VisionWorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  role: "image" | "text" | null = null;
  images = 0;
  texts: string[][] = [];
  blobs: Blob[] = [];
  readonly script: WorkerScript;
  constructor(script: WorkerScript) {
    this.script = script;
  }

  private send(msg: VisionWorkerResponse) {
    setTimeout(() => !this.terminated && this.onmessage?.({ data: msg } as MessageEvent<VisionWorkerResponse>), 0);
  }

  postMessage(msg: VisionWorkerRequest): void {
    if (msg.type === "init") {
      this.role = msg.role;
      if (this.script.initHangs) return;
      this.send(this.script.initFails ? { type: "init-failed", error: this.script.initFails } : { type: "ready", loadMs: 5 });
      return;
    }
    if (msg.type === "text") {
      this.texts.push(msg.prompts);
      this.send({ type: "text-done", id: msg.id, vectors: Float32Array.from(msg.prompts.flatMap(textVec)), ms: 1 });
      return;
    }
    this.images++;
    const seen = (this.script.seen ??= { n: 0 });
    seen.n++;
    if (this.script.alwaysCrash || this.script.crashOnImage === seen.n) {
      setTimeout(() => this.onerror?.({ message: "boom" } as ErrorEvent), 0);
      return;
    }
    if (this.script.hangOnImage === seen.n) return;
    if (msg.blob) {
      this.blobs.push(msg.blob);
      void msg.blob.text().then((t) => this.send(t === "CAT" ? { type: "image-done", id: msg.id, vector: Float32Array.from([1, 0, 0, 0]), ms: 1 } : t === "BAD" ? { type: "failed", id: msg.id, error: "undecodable", reason: "decode" } : { type: "image-done", id: msg.id, vector: Float32Array.from([0, 0, 0, 1]), ms: 1 }));
      return;
    }
    const cat = msg.rgb![0] === 1;
    this.send({ type: "image-done", id: msg.id, vector: Float32Array.from(cat ? [0.9, 0.1, 0, 0] : [0, 0, 0.2, 0.9]).map((x, _, a) => x / Math.hypot(...a)), ms: 1 });
  }

  terminate(): void {
    this.terminated = true;
  }
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function harness(script: WorkerScript = {}, fetchImpl?: (url: string, init?: RequestInit) => Response | Promise<Response>, extra: Partial<VisionHostDeps> = {}) {
  const workers: FakeVisionWorker[] = [];
  const statuses: VisionStatus[] = [];
  const fetches: FetchCall[] = [];
  let now = 1_000;
  const host = new VisionHost({
    createWorker: () => {
      const w = new FakeVisionWorker(script);
      workers.push(w);
      return w;
    },
    assetUrl: (p) => `chrome-extension://x/offscreen/${p}`,
    fetch: (async (url: string, init?: RequestInit) => {
      fetches.push({ url, init });
      if (!fetchImpl) throw new Error("no network in tests");
      return fetchImpl(url, init);
    }) as typeof fetch,
    onStatus: (s) => statuses.push(s),
    now: () => now,
    sha256: async (s) => `h${s.length}:${s.slice(0, 16)}:${s.charCodeAt(0)}`,
    initTimeoutMs: 200,
    jobTimeoutMs: 200,
    ...extra,
  });
  const role = (r: "image" | "text") => workers.filter((w) => w.role === r);
  return { host, workers, image: () => role("image"), text: () => role("text"), statuses, fetches, advance: (ms: number) => (now += ms) };
}

const frame = (cat: boolean) => {
  const f = new Uint8Array(RGB_FRAME_BYTES);
  f[0] = cat ? 1 : 2;
  f[1] = Math.floor(Math.random() * 255);
  return bytesToBase64(f);
};
const msg = (image: OffscreenVision["image"], patch: Partial<OffscreenVision> = {}): OffscreenVision => ({
  type: "off:vision",
  target: "offscreen",
  frameKey: "1:0:doc",
  generation: 1,
  mode: "balanced",
  topics: [{ id: "t-cats", text: "cats" }],
  image,
  // Authorised by the service worker (no shutdown yet: grant 0).
  visionGrant: 0,
  // URL requests are approved by the service worker with a download grant.
  ...(image.kind === "url" ? { downloadGrant: 0 } : {}),
  ...patch,
});

function okDecision(r: VisionReply) {
  assert.ok(r.ok, r.ok ? "" : `${r.reason}: ${r.error}`);
  return r.decision;
}

test("VisionHost: nothing loads until the first image; then classifies from pixels", async () => {
  const { host, workers, image, text, statuses } = harness();
  assert.equal(workers.length, 0, "lazy: no worker at construction");
  assert.equal(host.getStatus().state, "idle");
  const d = okDecision(await host.classify(msg({ kind: "pixels", rgb: frame(true) })));
  assert.equal(image().length, 1);
  assert.equal(text().length, 1, "the text encoder runs in its own worker");
  assert.deepEqual([d.matched, d.topicId], [true, "t-cats"]);
  assert.equal(okDecision(await host.classify(msg({ kind: "pixels", rgb: frame(false) }))).matched, false);
  assert.deepEqual(statuses.map((s) => s.state), ["loading", "ready"]);
  assert.equal(host.getStatus().backend, "cpu");
  // Without a precomputed background, topic prompts + background are embedded once, in one batch.
  assert.equal(text()[0]!.texts.length, 1);
  assert.equal(text()[0]!.texts[0]!.length, topicPrompts("cats").length + VISION_BACKGROUND_PROMPTS.length);
  assert.equal(image()[0]!.texts.length, 0);
});

test("VisionHost: a matching precomputed background is used; a mismatching one is ignored", async () => {
  const good = { model: "siglip-base-p16-224-int8", prompts: [...VISION_BACKGROUND_PROMPTS], vectors: VISION_BACKGROUND_PROMPTS.map(textVec) };
  const a = harness({}, undefined, { loadBackground: async () => good });
  assert.ok(okDecision(await a.host.classify(msg({ kind: "pixels", rgb: frame(true) }))).matched);
  assert.equal(a.text()[0]!.texts[0]!.length, topicPrompts("cats").length, "only the topic is embedded");
  assert.equal(a.host.stats.backgroundPrecomputed, true);
  for (const bad of [{ ...good, model: "other-model" }, { ...good, prompts: good.prompts.slice(1) }, { ...good, vectors: good.vectors.map(() => [NaN, 0, 0, 0]) }, null]) {
    const b = harness({}, undefined, { loadBackground: async () => bad });
    await b.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
    assert.equal(b.text()[0]!.texts[0]!.length, topicPrompts("cats").length + VISION_BACKGROUND_PROMPTS.length, JSON.stringify(bad)?.slice(0, 60));
    assert.equal(b.host.stats.backgroundPrecomputed, false);
  }
});

test("VisionHost: the text encoder is released when idle and restarted only for a new topic", async () => {
  const { host, text } = harness({}, undefined, { textIdleMs: 30 });
  await host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(text()[0]!.terminated, "idle text worker terminated (its memory is returned)");
  await host.classify(msg({ kind: "pixels", rgb: frame(false) }));
  assert.equal(text().length, 1, "cached topic: no new text worker");
  await host.classify(msg({ kind: "pixels", rgb: frame(false) }, { generation: 2, topics: [{ id: "d", text: "dogs" }] }));
  assert.equal(text().length, 2, "a new topic starts one");
  assert.equal(host.stats.textWorkerStarts, 2);
});

test("VisionHost: image and topic embeddings are cached; a topic change re-scores without re-running the image", async () => {
  const { host, image, text } = harness();
  const cat = frame(true);
  await host.classify(msg({ kind: "pixels", rgb: cat }));
  await host.classify(msg({ kind: "pixels", rgb: cat }, { generation: 1 }));
  assert.equal(image()[0]!.images, 1, "same pixels: no second inference");
  assert.equal(host.stats.cacheHits, 1);
  const d = okDecision(await host.classify(msg({ kind: "pixels", rgb: cat }, { generation: 2, topics: [{ id: "t-land", text: "landscapes" }] })));
  assert.equal(d.matched, false);
  assert.equal(image()[0]!.images, 1, "new topic, cached image");
  assert.equal(text()[0]!.texts.length, 2, "only the new topic is embedded");
  assert.equal(text()[0]!.texts[1]!.length, 3);
});

test("VisionHost: per frame, older generations are answered stale without inference", async () => {
  const { host, workers } = harness();
  const first = host.classify(msg({ kind: "pixels", rgb: frame(true) }, { generation: 1 }));
  const queued = host.classify(msg({ kind: "pixels", rgb: frame(false) }, { generation: 1 }));
  const newer = host.classify(msg({ kind: "pixels", rgb: frame(false) }, { generation: 2 }));
  const other = host.classify(msg({ kind: "pixels", rgb: frame(false) }, { generation: 1, frameKey: "2:0:other" }));
  const late = await host.classify(msg({ kind: "pixels", rgb: frame(true) }, { generation: 1 }));
  assert.deepEqual([late.ok, !late.ok && late.reason], [false, "stale"]);
  const q = await queued;
  assert.deepEqual([q.ok, !q.ok && q.reason], [false, "stale"]);
  for (const r of await Promise.all([first, newer, other])) assert.ok(r.ok, "the running job, the newer job and other frames complete");
  assert.equal(workers.filter((w) => w.role === "image")[0]!.images, 3);
  assert.ok(host.stats.staleDropped >= 2);
});

test("VisionHost: a full queue refuses work as overloaded (retryable)", async () => {
  const { host } = harness({}, undefined, { maxQueuedJobs: 2 });
  const jobs = Array.from({ length: 5 }, (_, i) => host.classify(msg({ kind: "pixels", rgb: frame(true) }, { frameKey: `f${i}` })));
  const replies = await Promise.all(jobs);
  const overloaded = replies.filter((r) => !r.ok && r.reason === "overloaded");
  assert.ok(overloaded.length >= 2, `got ${replies.map((r) => (r.ok ? "ok" : r.reason)).join(",")}`);
  assert.equal(host.stats.overloadRejected, overloaded.length);
});

const imgResponse = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "image/jpeg", ...headers } });

test("VisionHost: downloads omit credentials and the referrer, and accept images only", async () => {
  const { host, fetches, image } = harness({}, (url) => (url.includes("cat") ? imgResponse("CAT") : url.includes("html") ? new Response("<html>", { headers: { "content-type": "text/html" } }) : url.includes("svg") ? imgResponse("<svg/>", { "content-type": "image/svg+xml" }) : url.includes("404") ? new Response("", { status: 404 }) : imgResponse("LAND")));
  assert.equal(okDecision(await host.classify(msg({ kind: "url", url: "https://cdn.example.com/cat.jpg" }))).matched, true);
  assert.equal(fetches[0]!.init?.credentials, "omit");
  assert.equal(fetches[0]!.init?.referrerPolicy, "no-referrer");
  // Cached by URL: no second download.
  await host.classify(msg({ kind: "url", url: "https://cdn.example.com/cat.jpg" }));
  assert.equal(fetches.length, 1);
  for (const [url, reason] of [["https://cdn.example.com/page.html", "download-failed"], ["https://cdn.example.com/icon.svg", "download-failed"], ["https://cdn.example.com/404.jpg", "download-failed"], ["http://192.168.0.1/cam.jpg", "ineligible-url"], ["http://localhost/x.jpg", "ineligible-url"]] as const) {
    const r = await host.classify(msg({ kind: "url", url }));
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, reason], url);
  }
  assert.ok(!fetches.some((f) => /192\.168|localhost/.test(f.url)), "ineligible URLs are never fetched");
  assert.equal(image()[0]!.blobs.length, 1, "rejected bodies never reach the decoder");
});

test("VisionHost: oversized bodies are rejected by header and while streaming", async () => {
  const big = new Uint8Array(9 * 1024 * 1024);
  const { host } = harness({}, (url) => {
    if (url.includes("declared")) return imgResponse("x", { "content-length": String(50 * 1024 * 1024) });
    return new Response(big, { headers: { "content-type": "image/png" } });
  });
  for (const [url, reason] of [["https://a.example/declared.jpg", "too-large"], ["https://a.example/stream.png", "too-large"]] as const) {
    const r = await host.classify(msg({ kind: "url", url }));
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, reason], url);
  }
});

test("VisionHost: decode failures are reported per image and do not affect the next one", async () => {
  const { host } = harness({}, (url) => imgResponse(url.includes("bad") ? "BAD" : "CAT"));
  const bad = await host.classify(msg({ kind: "url", url: "https://a.example/bad.jpg" }));
  assert.deepEqual([bad.ok, !bad.ok && bad.reason], [false, "decode"]);
  assert.ok((await host.classify(msg({ kind: "url", url: "https://a.example/cat.jpg" }))).ok);
  assert.equal(host.getStatus().state, "ready");
});

test("VisionHost: initialisation failure is reported truthfully and retried after a cooldown", async () => {
  const h = harness({ initFails: "no WebAssembly" });
  const r = await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "unavailable"]);
  assert.equal(h.host.getStatus().state, "error");
  assert.match(h.host.getStatus().detail ?? "", /no WebAssembly/);
  assert.ok(h.image()[0]!.terminated);
  await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.equal(h.image().length, 1, "no retry storm within the cooldown");
  h.advance(5 * 60_000);
  await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.equal(h.image().length, 2, "retried after the cooldown");
});

test("VisionHost: an initialisation that never finishes times out into the error state", async () => {
  const h = harness({ initHangs: true });
  const r = await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "unavailable"]);
  assert.match(h.host.getStatus().detail ?? "", /timed out/);
});

test("VisionHost: a crashed or hung worker is restarted; repeated failures end in the error state", async () => {
  const h = harness({ crashOnImage: 1 });
  const r1 = await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.equal(r1.ok, false);
  const r2 = await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.ok(r2.ok, "restarted worker serves the next request");
  assert.equal(h.image().length, 2);

  const hang = harness({ hangOnImage: 1 });
  const t = await hang.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.deepEqual([t.ok, !t.ok && t.reason], [false, "inference"]);
  assert.ok(hang.image()[0]!.terminated, "a hung worker is not reused");

  const always = harness({ alwaysCrash: true });
  for (let i = 0; i < 4; i++) await always.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.equal(always.host.getStatus().state, "error");
  assert.equal(always.image().length, 3, "initial worker + 2 restarts");
});

test("VisionHost: shutdown unloads both models, answers queued work and clears caches", async () => {
  const { host, workers, image, text } = harness();
  await host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  const queued = [host.classify(msg({ kind: "pixels", rgb: frame(true) }, { frameKey: "a" })), host.classify(msg({ kind: "pixels", rgb: frame(true) }, { frameKey: "b" }))];
  host.shutdown();
  assert.ok(workers.every((w) => w.terminated));
  assert.equal(host.getStatus().state, "idle");
  const replies = await Promise.all(queued);
  assert.ok(replies.some((r) => !r.ok && r.reason === "disabled"));
  await host.classify(msg({ kind: "pixels", rgb: frame(true) }));
  assert.equal(image().length, 2, "a later request loads a fresh model");
  assert.equal(text().length, 2);
  assert.equal(text()[1]!.texts.length, 1, "topic cache was cleared");
});

test("VisionHost: a text-encoder crash fails that job (retryable) without touching the image model", async () => {
  const h = harness();
  const orig = FakeVisionWorker.prototype.postMessage;
  let crashed = false;
  FakeVisionWorker.prototype.postMessage = function (this: FakeVisionWorker, m: VisionWorkerRequest) {
    if (m.type === "text" && !crashed) {
      crashed = true;
      setTimeout(() => this.onerror?.({ message: "text boom" } as ErrorEvent), 0);
      return;
    }
    orig.call(this, m);
  };
  try {
    const r = await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }));
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "inference"]);
    assert.equal(h.host.getStatus().state, "ready", "image model unaffected");
    assert.ok((await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }))).ok);
    assert.equal(h.text().length, 2);
    assert.equal(h.image().length, 1);
  } finally {
    FakeVisionWorker.prototype.postMessage = orig;
  }
});

// ── Download security and consent lifecycle (Task 05.1) ───────────────────

/**
 * A fetch that behaves like the browser's for redirects: with
 * `redirect: "follow"` it requests the Location target itself (recording
 * it); with "manual" it returns the opaque redirect response and requests
 * nothing else.
 */
function redirectingFetch(target: string) {
  const requested: { url: string; init?: RequestInit }[] = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    requested.push({ url, init });
    if (url === target) return imgResponse("CAT");
    if (init?.redirect === "follow") return impl(target, init);
    if (init?.redirect === "error") throw new TypeError("redirect");
    // Cross-origin manual redirect: an opaque response, Location unreadable.
    return { type: "opaqueredirect", status: 0, ok: false, redirected: false, url: "", headers: new Headers(), body: null } as unknown as Response;
  };
  return { requested, impl };
}

test("security: a redirect to a private address is never requested (manual redirects, opaque redirects refused)", async () => {
  for (const target of ["http://127.0.0.1/admin.jpg", "http://169.254.169.254/latest/meta-data", "http://192.168.1.1/cam.jpg", "http://localhost/x.jpg"]) {
    const { requested, impl } = redirectingFetch(target);
    const { host } = harness({}, impl);
    const r = await host.classify(msg({ kind: "url", url: "https://cdn.example.com/redirect.jpg" }));
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "download-failed"], target);
    assert.match(!r.ok ? r.error : "", /redirect/);
    assert.deepEqual(requested.map((q) => q.url), ["https://cdn.example.com/redirect.jpg"], `${target} was never requested`);
    assert.equal(requested[0]!.init?.redirect, "manual");
    assert.equal(requested[0]!.init?.credentials, "omit");
    assert.equal(requested[0]!.init?.referrerPolicy, "no-referrer");
  }
  // Same-origin manual redirects arrive as a readable 3xx: also refused.
  const { host } = harness({}, () => new Response(null, { status: 302, headers: { location: "http://10.0.0.5/x.jpg" } }));
  const r = await host.classify(msg({ kind: "url", url: "https://cdn.example.com/a.jpg" }));
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "download-failed"]);
});

/** A fetch that never answers on its own; it rejects like the browser's when aborted. */
function hangingFetch() {
  const calls: { url: string; signal: AbortSignal }[] = [];
  const impl = (url: string, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      const signal = init!.signal!;
      calls.push({ url, signal });
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  return { calls, impl };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), what);
}

/** Fails the test on any unhandled rejection while `fn` runs (and shortly after). */
async function noUnhandledRejections(fn: () => Promise<void>): Promise<void> {
  const seen: unknown[] = [];
  const on = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", on);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off("unhandledRejection", on);
  }
  assert.deepEqual(seen, [], "no unhandled rejections");
}

test("lifecycle: shutdown aborts a download in flight at once; nothing restarts afterwards", () =>
  noUnhandledRejections(async () => {
    const { calls, impl } = hangingFetch();
    const h = harness({}, impl);
    const pending = h.host.classify(msg({ kind: "url", url: "https://cdn.example.com/slow.jpg" }));
    await until(() => calls.length === 1, "download started");
    assert.equal(h.host.activeDownloads(), 1);
    h.host.shutdown();
    assert.equal(calls[0]!.signal.aborted, true, "aborted synchronously by shutdown()");
    assert.equal(h.host.activeDownloads(), 0);
    const r = await pending;
    assert.deepEqual([r.ok, !r.ok && r.reason], [false, "disabled"]);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(h.host.getStatus().state, "idle", "no model resurrection");
    assert.ok(h.workers.every((w) => w.terminated));
    assert.equal(calls.length, 1, "no new download");
  }));

test("lifecycle: revoking downloads aborts the one in flight and refuses queued ones; pixels and the model keep working", () =>
  noUnhandledRejections(async () => {
    const { calls, impl } = hangingFetch();
    const h = harness({}, impl);
    await h.host.classify(msg({ kind: "pixels", rgb: frame(true) })); // model loaded
    const inFlight = h.host.classify(msg({ kind: "url", url: "https://cdn.example.com/a.jpg" }, { frameKey: "a" }));
    const queued = h.host.classify(msg({ kind: "url", url: "https://cdn.example.com/b.jpg" }, { frameKey: "b" }));
    await until(() => calls.length === 1, "first download started");
    h.host.revokeDownloads(1_000);
    assert.equal(calls[0]!.signal.aborted, true);
    for (const r of await Promise.all([inFlight, queued])) assert.deepEqual([r.ok, !r.ok && r.reason], [false, "downloads-off"]);
    assert.equal(calls.length, 1, "the queued download (approved before the revocation) never started");
    // Pixel analysis, the image model and its worker are unaffected.
    assert.ok(okDecision(await h.host.classify(msg({ kind: "pixels", rgb: frame(true) }))).matched);
    assert.equal(h.host.getStatus().state, "ready");
    assert.equal(h.image().length, 1);
    assert.equal(h.image()[0]!.terminated, false);
  }));

test("lifecycle: a request approved before a revocation but delivered after it never reaches the network", async () => {
  const { calls, impl } = hangingFetch();
  const h = harness({}, impl);
  h.host.revokeDownloads(2_000);
  const late = await h.host.classify(msg({ kind: "url", url: "https://cdn.example.com/late.jpg" }, { downloadGrant: 1_999 }));
  assert.deepEqual([late.ok, !late.ok && late.reason], [false, "downloads-off"]);
  const missing = await h.host.classify(msg({ kind: "url", url: "https://cdn.example.com/late.jpg" }, { downloadGrant: undefined }));
  assert.deepEqual([missing.ok, !missing.ok && missing.reason], [false, "downloads-off"], "no grant, no download");
  assert.equal(calls.length, 0);
  // Re-enabled later: a grant issued after the revocation works again.
  void h.host.classify(msg({ kind: "url", url: "https://cdn.example.com/again.jpg" }, { downloadGrant: 2_000 }));
  await until(() => calls.length === 1, "download allowed again");
  h.host.shutdown();
});

test("lifecycle: shutdown during model initialisation settles waiting work and does not resurrect the model", () =>
  noUnhandledRejections(async () => {
    const { calls, impl } = hangingFetch();
    const h = harness({ initHangs: true }, impl, { initTimeoutMs: 5_000 });
    const pixel = h.host.classify(msg({ kind: "pixels", rgb: frame(true) }, { frameKey: "p" }));
    const url = h.host.classify(msg({ kind: "url", url: "https://cdn.example.com/x.jpg" }, { frameKey: "u" }));
    await until(() => h.workers.length === 1, "initialisation started");
    const t0 = Date.now();
    h.host.shutdown();
    const replies = await Promise.all([pixel, url]);
    assert.ok(Date.now() - t0 < 1_000, "settled at once, not after the initialisation timeout");
    for (const r of replies) assert.deepEqual([r.ok, !r.ok && r.reason], [false, "disabled"]);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(h.host.getStatus().state, "idle", "no 'error' or 'ready' status after shutdown");
    assert.equal(h.workers.length, 1, "no worker started after shutdown");
    assert.equal(calls.length, 0, "no download after shutdown");
  }));
