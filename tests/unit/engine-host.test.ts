import assert from "node:assert/strict";
import { test } from "node:test";

import { EngineHost, type EngineHostDeps, type ModelMeta, type WorkerLike } from "../../src/offscreen/engine-host.ts";
import { BACKGROUND_TOPICS } from "../../src/shared/models.ts";
import { SIBLING_PHRASES } from "../../src/shared/siblings.ts";
import type { Backend, ClassifyReply, EngineStatus, OffscreenClassify, WorkerRequest, WorkerResponse } from "../../src/shared/protocol.ts";

const DIM = 4;

/**
 * Deterministic fake embedding: one orthogonal axis per cluster (crypto,
 * sports, stocks, other). "shares" texts lean towards crypto but are closer
 * to stocks, a sibling of cryptocurrency (siblings.ts).
 */
function fakeEmbed(text: string): number[] {
  const t = text.toLowerCase();
  if (/shares/.test(t)) return [0.5, 0, Math.sqrt(0.75), 0];
  if (t === "stock market") return [0, 0, 1, 0];
  return /crypto|bitcoin|coin/.test(t) ? [1, 0, 0, 0] : /sport|goal/.test(t) ? [0, 1, 0, 0] : [0, 0, 0, 1];
}

const SELFTEST = ["self test sentence one", "self test sentence two"];
const META: ModelMeta = {
  id: "minilm-l6",
  selftest: { texts: SELFTEST, embeddings: SELFTEST.map(fakeEmbed), max_abs_tol: 1e-3 },
  background: { topics: [...BACKGROUND_TOPICS], embeddings: BACKGROUND_TOPICS.map(fakeEmbed) },
  siblings: { phrases: [...SIBLING_PHRASES], embeddings: SIBLING_PHRASES.map(fakeEmbed) },
};

type Behaviour = {
  /** Fail init on these backends. */
  initFails?: Backend[];
  /** After this many successful embeds, the backend starts failing. */
  failAfter?: Partial<Record<Backend, number>>;
  /** Return corrupted vectors (but no error) on this backend … */
  corrupt?: Backend[];
  /** … starting after this many embeds (default 1: the self-test passes). */
  corruptAfter?: number;
  /** Hold embed replies until released. */
  manual?: boolean;
  /** Fail exactly these embed numbers (1-based, per worker) once. */
  failOnce?: Partial<Record<Backend, number[]>>;
  /** Shared across workers: how many times each backend was started. */
  starts?: Partial<Record<Backend, number>>;
  /** The worker crashes (error event) on this embed number. */
  crashOn?: Partial<Record<Backend, number>>;
  /** The worker never answers this embed number. */
  hangOn?: Partial<Record<Backend, number>>;
};

class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  backend: Backend | null = null;
  terminated = false;
  embeds = 0;
  embedTexts: string[][] = [];
  held: (() => void)[] = [];
  private readonly b: Behaviour;
  readonly log: string[];
  constructor(b: Behaviour, log: string[]) {
    this.b = b;
    this.log = log;
  }

  private send(msg: WorkerResponse) {
    queueMicrotask(() => !this.terminated && this.onmessage?.({ data: msg } as MessageEvent<WorkerResponse>));
  }

  postMessage(msg: WorkerRequest): void {
    if (msg.type === "init") {
      this.backend = msg.backend;
      this.log.push(`init:${msg.backend}`);
      if (this.b.starts) this.b.starts[msg.backend] = (this.b.starts[msg.backend] ?? 0) + 1;
      if (this.b.initFails?.includes(msg.backend)) this.send({ type: "init-failed", error: `${msg.backend} unavailable` });
      else this.send({ type: "ready", backend: msg.backend, dim: DIM, loadMs: 5, wasmMemoryBytes: 1, wasmMemoryBeforeModelBytes: 1 });
      return;
    }
    const backend = this.backend!;
    const respond = () => {
      this.embeds++;
      this.embedTexts.push(msg.texts);
      if (this.b.crashOn?.[backend] === this.embeds) {
        queueMicrotask(() => !this.terminated && this.onerror?.({ message: "simulated worker crash" } as ErrorEvent));
        return;
      }
      if (this.b.hangOn?.[backend] === this.embeds) return;
      if (this.b.failOnce?.[backend]?.includes(this.embeds) && (this.b.starts?.[backend] ?? 1) === 1) {
        this.send({ type: "embed-failed", id: msg.id, error: "transient failure" });
        return;
      }
      const limit = this.b.failAfter?.[backend];
      if (limit !== undefined && this.embeds > limit) {
        this.send({ type: "embed-failed", id: msg.id, error: "device lost" });
        return;
      }
      const vectors = new Float32Array(msg.texts.length * DIM);
      msg.texts.forEach((t, i) => vectors.set(this.b.corrupt?.includes(backend) && this.embeds > (this.b.corruptAfter ?? 1) ? [0.5, 0.5, 0.5, 0.5] : fakeEmbed(t), i * DIM));
      this.send({ type: "embedded", id: msg.id, vectors, ms: 1, wasmMemoryBytes: 1 });
    };
    if (this.b.manual) this.held.push(respond);
    else respond();
  }

  terminate(): void {
    this.terminated = true;
    this.log.push(`terminate:${this.backend}`);
  }
}

function makeHost(b: Behaviour = {}, backends: Backend[] = ["webgpu", "cpu"], opts: Partial<EngineHostDeps> = {}) {
  const log: string[] = [];
  const workers: FakeWorker[] = [];
  const statuses: EngineStatus[] = [];
  const host = new EngineHost({
    createWorker: () => {
      const w = new FakeWorker(b, log);
      workers.push(w);
      return w;
    },
    assetUrl: (p) => `ext://${p}`,
    backends: async () => [...backends],
    loadModelMeta: async () => META,
    onStatus: (s) => statuses.push(s),
    now: () => Date.now(),
    initTimeoutMs: 200,
    embedTimeoutMs: 200,
    ...opts,
  });
  return { host, log, workers, statuses };
}

function req(texts: string[], generation = 1, frameKey = "1:0:a", topics = [{ id: "t", text: "cryptocurrency" }]): OffscreenClassify {
  return { type: "off:classify", target: "offscreen", frameKey, generation, mode: "balanced", topics, texts };
}

const matched = (r: ClassifyReply) => (r.ok ? r.decisions.map((d) => d.matched) : r.error);
const verdicts = (r: ClassifyReply) => (r.ok ? r.decisions.map((d) => [d.matched, d.via]) : r.error);
const tick = () => new Promise((r) => setTimeout(r, 0));

test("requests sent before initialisation are answered after it completes", async () => {
  const { host, statuses } = makeHost();
  const replies = await Promise.all([host.classify(req(["Bitcoin rallies again today"])), host.classify(req(["The bakery sells bread", "Bitcoin coin prices doubled"], 1, "2:0:b"))]);
  assert.deepEqual(replies.map(matched), [[true], [false, true]]);
  assert.equal(statuses.at(0)!.state, "loading");
  assert.equal(host.getStatus().state, "semantic");
  assert.equal(host.getStatus().backend, "webgpu");
});

test("queued requests from an older generation of the same frame are dropped", async () => {
  const { host, workers } = makeHost({ manual: true });
  const first = host.classify(req(["Bitcoin rallies again today"], 1));
  // Let initialisation + self-test run, leaving the first job's embed held.
  for (let i = 0; i < 20 && !(workers[0]?.held.length); i++) await tick();
  workers[0]!.held.shift()!(); // self-test
  for (let i = 0; i < 20 && workers[0]!.held.length === 0; i++) await tick();
  const older = host.classify(req(["Bitcoin is old news"], 1));
  const newer = host.classify(req(["Sports goal of the season"], 2));
  const otherFrame = host.classify(req(["Bitcoin news in another browser tab"], 1, "9:0:z"));
  const release = async () => {
    while (true) {
      await tick();
      const h = workers[0]!.held.shift();
      if (h) h();
      else if (workers[0]!.held.length === 0) {
        await tick();
        if (workers[0]!.held.length === 0) return;
      }
    }
  };
  const done = Promise.all([first, older, newer, otherFrame]);
  void release();
  const [r1, r2, r3, r4] = await done;
  // The job already running when gen 2 arrived completes (its reply is
  // discarded by the content script); the queued gen-1 job is dropped.
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.ok(!r2.ok && r2.stale);
  assert.deepEqual(matched(r3), [false]);
  assert.deepEqual(matched(r4), [true], `other frames are unaffected: ${JSON.stringify(r4)}`);
  assert.equal(host.stats.staleDropped, 1);
});

test("replies always carry the generation and topics of their own request", async () => {
  const { host } = makeHost();
  const a = host.classify(req(["Bitcoin rallies again today"], 5, "f", [{ id: "crypto", text: "cryptocurrency" }]));
  const b = host.classify(req(["Bitcoin rallies again today"], 6, "f", [{ id: "sport", text: "sports" }]));
  const [ra, rb] = await Promise.all([a, b]);
  // Job 5 was already running (waiting for init) when 6 arrived, so it
  // completes — with its own crypto topic. Job 6 uses its sports topic.
  assert.equal(ra.generation, 5);
  assert.ok(ra.ok);
  assert.deepEqual(ra.decisions.map((d) => [d.matched, d.topicId]), [[true, "crypto"]]);
  assert.equal(rb.generation, 6);
  assert.ok(rb.ok);
  assert.deepEqual(rb.decisions.map((d) => d.matched), [false], "uses the sports topic of request 6, not crypto");
});

test("falls back to CPU when WebGPU fails to initialise", async () => {
  const { host, log } = makeHost({ initFails: ["webgpu"] });
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(matched(r), [true]);
  assert.deepEqual(log.slice(0, 3), ["init:webgpu", "terminate:webgpu", "init:cpu"]);
  assert.equal(host.getStatus().backend, "cpu");
  assert.match(host.getStatus().detail!, /webgpu unavailable/);
});

test("degrades to lexical-only and says so when every backend fails", async () => {
  const { host } = makeHost({ initFails: ["webgpu", "cpu"] });
  const r = await host.classify(req(["Cryptocurrency exchange hacked", "The bakery sells bread"]));
  assert.ok(r.ok);
  assert.deepEqual(r.decisions.map((d) => [d.matched, d.via]), [[true, "lexical"], [false, null]]);
  assert.equal(host.getStatus().state, "lexical-fallback");
  assert.equal(r.engine.state, "lexical-fallback");
});

test("runtime failure on GPU fails over to CPU and retries the same job", async () => {
  const { host, log } = makeHost({ failAfter: { webgpu: 1 } }); // self-test ok, first real embed fails
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(matched(r), [true]);
  assert.equal(host.getStatus().backend, "cpu");
  assert.match(host.getStatus().detail!, /device lost/);
  assert.ok(log.includes("terminate:webgpu"));
});

const states = (statuses: EngineStatus[]) =>
  statuses.map((s) => `${s.state}:${s.backend}`).filter((s, i, all) => s !== all[i - 1]);

test("GPU fails, CPU fails, CPU restarts: the same job completes on the restarted worker", async () => {
  const starts: Partial<Record<Backend, number>> = {};
  // WebGPU: self-test ok, first real embed fails. First CPU worker: self-test
  // ok, first real embed fails. Restarted CPU worker: works.
  const { host, log, workers, statuses } = makeHost({ failAfter: { webgpu: 1 }, failOnce: { cpu: [2] }, starts });
  const r = await host.classify(req(["Bitcoin rallies again today"])); // semantic match only, no keyword
  assert.deepEqual(log, ["init:webgpu", "terminate:webgpu", "init:cpu", "terminate:cpu", "init:cpu"]);
  assert.deepEqual(starts, { webgpu: 1, cpu: 2 });
  assert.deepEqual(verdicts(r), [[true, "semantic"]], "the job is retried on the recovered backend, not answered lexically");
  assert.ok(r.ok && r.engine.state === "semantic" && r.engine.backend === "cpu");
  assert.ok(workers[2]!.embedTexts.some((b) => b.includes("Bitcoin rallies again today")), "embedded by the restarted worker");
  assert.deepEqual(states(statuses), ["loading:null", "loading:webgpu", "semantic:webgpu", "loading:cpu", "semantic:cpu", "loading:cpu", "semantic:cpu"]);
});

test("when every backend fails at run time the job ends in a consistent lexical fallback", async () => {
  const starts: Partial<Record<Backend, number>> = {};
  const { host, log, workers } = makeHost({ failAfter: { webgpu: 1, cpu: 1 }, starts });
  const r = await host.classify(req(["Cryptocurrency exchange hacked", "Bitcoin rallies again today"]));
  // One WebGPU worker, then the CPU worker and its MAX_RESTARTS (2) restarts.
  assert.deepEqual(starts, { webgpu: 1, cpu: 3 });
  assert.equal(log.filter((l) => l.startsWith("init:")).length, 4);
  assert.ok(workers.every((w) => w.terminated), "no worker is left running");
  assert.deepEqual(verdicts(r), [[true, "lexical"], [false, null]]);
  assert.ok(r.ok && r.engine.state === "lexical-fallback" && r.engine.backend === null, `reply engine: ${JSON.stringify(r.engine)}`);
  assert.equal(host.getStatus().state, "lexical-fallback");
  assert.match(host.getStatus().detail!, /device lost/);
});

test("after a run-time degradation, a later request recovers once the cooldown has passed", async () => {
  let now = 1_000_000;
  const b: Behaviour = { failAfter: { webgpu: 1, cpu: 1 } };
  const { host, workers } = makeHost(b, ["webgpu", "cpu"], { now: () => now });
  await host.classify(req(["Bitcoin rallies again today"]));
  assert.equal(host.getStatus().state, "lexical-fallback");
  const created = workers.length;
  b.failAfter = {};
  now += 60_000;
  const early = await host.classify(req(["Bitcoin rallies again today"], 2));
  assert.deepEqual(verdicts(early), [[false, null]], "lexical only before the cooldown");
  assert.equal(workers.length, created, "no restart before the cooldown");
  now += 10 * 60_000;
  const late = await host.classify(req(["Bitcoin rallies again today"], 3));
  assert.deepEqual(verdicts(late), [[true, "semantic"]]);
  assert.ok(late.ok && late.engine.state === "semantic" && late.engine.backend === "webgpu");
});

test("a backend that fails to initialise during fail-over is skipped and reported", async () => {
  const { host } = makeHost({ failAfter: { webgpu: 1 }, initFails: ["cpu"] });
  const r = await host.classify(req(["Cryptocurrency exchange hacked", "Bitcoin rallies again today"]));
  assert.deepEqual(verdicts(r), [[true, "lexical"], [false, null]]);
  assert.ok(r.ok && r.engine.state === "lexical-fallback");
  assert.match(host.getStatus().detail!, /device lost.*cpu unavailable/);
});

test("a worker crash during an embed fails over and completes the same job", async () => {
  const { host } = makeHost({ crashOn: { webgpu: 2 } });
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(verdicts(r), [[true, "semantic"]]);
  assert.ok(r.ok && r.engine.backend === "cpu");
  assert.match(host.getStatus().detail!, /simulated worker crash/);
});

test("an embed that times out fails over and completes the same job", async () => {
  const { host, log } = makeHost({ hangOn: { webgpu: 2 } }, ["webgpu", "cpu"], { embedTimeoutMs: 30 });
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(verdicts(r), [[true, "semantic"]]);
  assert.ok(r.ok && r.engine.backend === "cpu");
  assert.ok(log.includes("terminate:webgpu"));
  assert.match(host.getStatus().detail!, /timed out after 30 ms/);
});

test("cached vectors of a replaced backend are not reused", async () => {
  // WebGPU: self-test, job 1 ok; job 2 fails.
  const { host, workers } = makeHost({ failAfter: { webgpu: 2 } });
  await host.classify(req(["Bitcoin rallies again today"]));
  const r = await host.classify(req(["Bitcoin rallies again today", "The bakery sells bread"], 2));
  assert.deepEqual(verdicts(r), [[true, "semantic"], [false, null]]);
  const cpu = workers[1]!;
  assert.equal(cpu.backend, "cpu");
  // Everything job 2 needs, including what WebGPU had cached, is re-embedded on CPU.
  assert.deepEqual(cpu.embedTexts.at(-1)!.toSorted(), ["Bitcoin rallies again today", "The bakery sells bread", "cryptocurrency"]);
});

test("background vectors embedded on a replaced backend are recomputed on the new one", async () => {
  const workers: FakeWorker[] = [];
  // No precomputed vectors: WebGPU embeds self-test (1), background (2), siblings (3), fails on the job (4).
  const host = new EngineHost({
    createWorker: () => {
      const w = new FakeWorker({ failAfter: { webgpu: 3 } }, []);
      workers.push(w);
      return w;
    },
    assetUrl: (p) => p,
    backends: async () => ["webgpu", "cpu"],
    loadModelMeta: async () => ({ id: META.id, selftest: META.selftest }),
    onStatus: () => {},
    now: () => Date.now(),
  });
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(verdicts(r), [[true, "semantic"]]);
  const isBackground = (b: string[]) => b.length === BACKGROUND_TOPICS.length && b[0] === BACKGROUND_TOPICS[0];
  assert.ok(workers[0]!.embedTexts.some(isBackground));
  assert.ok(workers[1]!.embedTexts.some(isBackground), "CPU re-embeds the background instead of using WebGPU's vectors");
});

test("replies keep their own generation and topic snapshot across fail-over", async () => {
  const { host } = makeHost({ failAfter: { webgpu: 1 } });
  const r = await host.classify(req(["Sports goal of the season", "Bitcoin rallies again today"], 7, "f", [{ id: "sport", text: "sports" }]));
  assert.equal(r.generation, 7);
  assert.ok(r.ok);
  assert.deepEqual(r.decisions.map((d) => [d.matched, d.topicId, d.via]), [[true, "sport", "semantic"], [false, null, null]]);
});

test("a job that exhausts its attempt budget fails explicitly; the recovered engine serves the next one", async () => {
  const { host } = makeHost({ failAfter: { webgpu: 1 } }, ["webgpu", "cpu"], { maxEmbedAttempts: 1 });
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.ok(!r.ok && !r.stale, "an explicit, retryable failure — not lexical verdicts labelled semantic");
  assert.match(r.error, /1 attempt/);
  assert.ok(r.engine?.state === "semantic" && r.engine.backend === "cpu", "engine-wide state stays truthful");
  const next = await host.classify(req(["Bitcoin rallies again today"], 2));
  assert.deepEqual(verdicts(next), [[true, "semantic"]]);
});

test("a GPU that returns wrong numbers is caught by the canary", async () => {
  const { host } = makeHost({ corrupt: ["webgpu"] });
  const r = await host.classify(req(["Bitcoin rallies again today", "The bakery sells bread"]));
  assert.deepEqual(matched(r), [true, false]);
  assert.equal(host.getStatus().backend, "cpu");
  assert.match(host.getStatus().detail!, /canary/);
  assert.equal(host.stats.canaryFailures, 1);
});

test("a backend failing the start-up self-test is never reported as semantic", async () => {
  const { host, statuses } = makeHost({ corrupt: ["webgpu"], corruptAfter: 0 });
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(matched(r), [true]);
  assert.ok(!statuses.some((s) => s.state === "semantic" && s.backend === "webgpu"));
  assert.equal(host.getStatus().backend, "cpu");
  assert.match(host.getStatus().detail!, /self-test failed/);
});

test("hung worker initialisation times out and moves on", async () => {
  const log: string[] = [];
  const host = new EngineHost({
    createWorker: () => {
      const w = new FakeWorker({}, log);
      const orig = w.postMessage.bind(w);
      w.postMessage = (m) => (m.type === "init" && m.backend === "webgpu" ? log.push("hang") : orig(m)) as unknown as void;
      return w;
    },
    assetUrl: (p) => p,
    backends: async () => ["webgpu", "cpu"],
    loadModelMeta: async () => META,
    onStatus: () => {},
    now: () => Date.now(),
    initTimeoutMs: 50,
  });
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(matched(r), [true]);
  assert.equal(host.getStatus().backend, "cpu");
  assert.match(host.getStatus().detail!, /timed out/);
});

test("changing the topic re-embeds only the topic, not the page", async () => {
  const { host, workers } = makeHost({}, ["cpu"]);
  const texts = ["Bitcoin rallies again today", "The bakery sells bread", "Sports goal of the season"];
  await host.classify(req(texts, 1, "f", [{ id: "a", text: "cryptocurrency" }]));
  const before = workers[0]!.embedTexts.length;
  const r = await host.classify(req(texts, 2, "f", [{ id: "b", text: "sports" }]));
  assert.deepEqual(matched(r), [false, false, true]);
  assert.deepEqual(workers[0]!.embedTexts.slice(before), [["sports"]]);
  assert.ok(host.stats.cacheHits >= 3);
});

test("unknown model ids are not silently given someone else's thresholds", async () => {
  const host = new EngineHost({
    createWorker: () => new FakeWorker({}, []),
    assetUrl: (p) => p,
    backends: async () => ["cpu"],
    loadModelMeta: async () => ({ ...META, id: "mystery-model" }),
    onStatus: () => {},
    now: () => Date.now(),
  });
  const r = await host.classify(req(["Cryptocurrency crash"]));
  assert.equal(host.getStatus().state, "lexical-fallback");
  assert.match(host.getStatus().detail!, /no calibrated profile/);
  assert.deepEqual(matched(r), [true]);
});

test("a transient failure on the last backend restarts it instead of degrading for good", async () => {
  const starts: Partial<Record<Backend, number>> = {};
  const { host } = makeHost({ failOnce: { cpu: [2] }, starts }, ["cpu"]);
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(matched(r), [true]);
  assert.equal(host.getStatus().state, "semantic");
  assert.equal(host.getStatus().backend, "cpu");
  assert.equal(starts.cpu, 2, "CPU worker was restarted once");
});

test("after degrading, initialisation is retried once the cooldown has passed", async () => {
  let now = 1_000_000;
  let fail = true;
  const host = new EngineHost({
    createWorker: () => new FakeWorker({ initFails: fail ? ["cpu"] : [] }, []),
    assetUrl: (p) => p,
    backends: async () => ["cpu"],
    loadModelMeta: async () => META,
    onStatus: () => {},
    now: () => now,
  });
  await host.classify(req(["Bitcoin rallies again today"]));
  assert.equal(host.getStatus().state, "lexical-fallback");
  fail = false;
  now += 60_000;
  await host.classify(req(["Bitcoin rallies again today"], 2));
  assert.equal(host.getStatus().state, "lexical-fallback", "no retry before the cooldown");
  now += 10 * 60_000;
  const r = await host.classify(req(["Bitcoin rallies again today"], 3));
  assert.equal(host.getStatus().state, "semantic");
  assert.deepEqual(matched(r), [true]);
});

test("per-frame generation bookkeeping is bounded", async () => {
  const { host } = makeHost({}, ["cpu"]);
  for (let i = 0; i < 1200; i++) await host.classify(req([], 1, `frame-${i}`));
  assert.ok(host.trackedFrames() <= 1000, `tracked ${host.trackedFrames()}`);
});

test("background vectors are embedded at run time when model.json lacks them", async () => {
  const log: string[] = [];
  const workers: FakeWorker[] = [];
  const host = new EngineHost({
    createWorker: () => {
      const w = new FakeWorker({}, log);
      workers.push(w);
      return w;
    },
    assetUrl: (p) => p,
    backends: async () => ["cpu"],
    loadModelMeta: async () => ({ id: META.id, selftest: META.selftest }),
    onStatus: () => {},
    now: () => Date.now(),
  });
  const r = await host.classify(req(["Bitcoin rallies again today"]));
  assert.deepEqual(matched(r), [true]);
  assert.ok(workers[0]!.embedTexts.some((b) => b.length === BACKGROUND_TOPICS.length && b[0] === BACKGROUND_TOPICS[0]));
});

// ── Scheduling: bounded queue, superseded work, overload ────────────────────

/** Observes a promise without awaiting it. */
function track<T>(p: Promise<T>): { done: boolean; value: T | undefined } {
  const t = { done: false, value: undefined as T | undefined };
  void p.then((v) => {
    t.done = true;
    t.value = v;
  });
  return t;
}

/** Yield to the event loop until `cond` holds (bounded; no wall-clock sleeps). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await tick();
  assert.ok(cond(), "condition not reached");
}

/** A CPU engine whose worker holds every embed: one job is left running, blocked. */
async function blockedHost(opts: Partial<EngineHostDeps> = {}, b: Behaviour = {}) {
  const h = makeHost({ ...b, manual: true }, ["cpu"], opts);
  const running = track(h.host.classify(req(["Bitcoin rallies again today"], 1, "running-frame")));
  await until(() => h.workers[0]?.held.length === 1);
  h.workers[0]!.held.shift()!(); // self-test
  await until(() => h.workers.at(-1)!.held.length === 1); // the job's embed, held
  return { ...h, running };
}

/** Release held embeds (on whichever worker is current) until every tracked reply settles. */
async function drain(workers: FakeWorker[], tracked: { done: boolean }[]): Promise<void> {
  for (let i = 0; i < 20_000 && !tracked.every((t) => t.done); i++) {
    workers.at(-1)?.held.shift()?.();
    await tick();
  }
  assert.ok(tracked.every((t) => t.done), `${tracked.filter((t) => !t.done).length} replies never settled`);
}

const isOverload = (r: ClassifyReply | undefined) => !!r && !r.ok && !r.stale && /overloaded/.test(r.error);

test("a blocked worker cannot make the queue grow without bound (many frames)", async () => {
  const { host, workers, running } = await blockedHost();
  const capacity = host.queueCapacity;
  assert.ok(capacity >= 100 && capacity <= 500, `capacity ${capacity} is in the low hundreds`);
  const n = 1000;
  // 50 frames, 20 requests each, interleaved; distinct texts so every job needs the worker.
  const replies = Array.from({ length: n }, (_, i) => track(host.classify(req([`Bitcoin rallies again today, post ${i}`], 1, `frame-${i % 50}`))));
  await tick();
  const settled = replies.filter((t) => t.done);
  assert.equal(settled.length, n - capacity, "requests beyond the capacity are answered at once");
  assert.ok(settled.every((t) => isOverload(t.value)), "as retryable overload errors, not stale and not dropped");
  assert.ok(settled.every((t) => t.value!.generation === 1 && t.value!.engine?.state === "semantic"));
  assert.ok(replies.slice(0, capacity).every((t) => !t.done), "the earliest requests keep their places (FIFO)");
  assert.equal(host.stats.overloadRejected, n - capacity);
  await drain(workers, [running, ...replies]);
  assert.ok(replies.slice(0, capacity).every((t) => t.value!.ok), "accepted work completes");
  assert.equal(host.stats.jobs, 1 + capacity, "rejected requests never ran");
});

test("a newer generation supersedes the frame's queued jobs at once; other frames are untouched", async () => {
  const { host, workers, running } = await blockedHost();
  const a1 = [1, 2, 3].map((i) => track(host.classify(req([`Bitcoin rallies again today, a${i}`], 1, "frame-a"))));
  const b1 = [1, 2].map((i) => track(host.classify(req([`Bitcoin rallies again today, b${i}`], 1, "frame-b"))));
  const a2 = track(host.classify(req(["Sports goal of the season"], 2, "frame-a")));
  await tick();
  assert.ok(a1.every((t) => t.done && !t.value!.ok && t.value!.stale && t.value!.generation === 1), "queued gen-1 jobs of frame a are answered stale immediately");
  assert.ok(b1.every((t) => !t.done), "frame b keeps its gen-1 jobs (generations are per frame)");
  assert.equal(host.stats.staleDropped, 3);
  // A late request for the superseded generation is answered stale without queueing.
  const late = track(host.classify(req(["Bitcoin rallies again today, late"], 1, "frame-a")));
  await tick();
  assert.ok(late.done && !late.value!.ok && late.value!.stale);
  assert.equal(host.stats.staleDropped, 4);
  await drain(workers, [running, ...b1, a2]);
  assert.ok(running.value!.ok, "the running job is not cancelled (the worker cannot cancel it)");
  assert.deepEqual(b1.map((t) => matched(t.value!)), [[true], [true]]);
  assert.equal(a2.value!.generation, 2);
  assert.deepEqual(matched(a2.value!), [false]);
  assert.equal(host.stats.jobs, 1 + 2 + 1, "superseded jobs never ran");
});

test("rapid settings changes over a backlog keep the queue small and answer only the newest generation", async () => {
  const { host, workers, running } = await blockedHost();
  const other = [1, 2].map((i) => track(host.classify(req([`Bitcoin rallies again today, other ${i}`], 1, "frame-b"))));
  const all: ReturnType<typeof track<ClassifyReply>>[] = [];
  // A frame sends its two in-flight requests for each of 300 successive generations.
  for (let g = 1; g <= 300; g++) {
    for (const i of [1, 2]) all.push(track(host.classify(req([`Bitcoin rallies again today, g${g} ${i}`], g, "frame-a"))));
  }
  await tick();
  const newest = all.slice(-2);
  assert.ok(all.slice(0, -2).every((t) => t.done && !t.value!.ok && t.value!.stale), "every superseded job was answered stale");
  assert.ok(newest.every((t) => !t.done) && other.every((t) => !t.done));
  assert.equal(host.stats.staleDropped, 2 * 299);
  assert.equal(host.stats.overloadRejected, 0, "superseded work never fills the queue");
  await drain(workers, [running, ...other, ...newest]);
  assert.ok(newest.every((t) => t.value!.ok && t.value!.generation === 300));
  assert.equal(host.stats.jobs, 1 + 2 + 2);
});

test("after an overload, normal service resumes once the backlog clears", async () => {
  const { host, workers, running } = await blockedHost({ maxQueuedJobs: 4 });
  assert.equal(host.queueCapacity, 4);
  const replies = Array.from({ length: 6 }, (_, i) => track(host.classify(req([`Bitcoin rallies again today, post ${i}`], 1, `frame-${i}`))));
  await tick();
  assert.deepEqual(replies.map((t) => t.done), [false, false, false, false, true, true]);
  assert.ok(replies.slice(4).every((t) => isOverload(t.value)));
  await drain(workers, [running, ...replies]);
  // The rejected frames retry later (the content script backs off) and are served.
  const retried = [4, 5].map((i) => track(host.classify(req([`Bitcoin rallies again today, post ${i}`], 1, `frame-${i}`))));
  await drain(workers, retried);
  assert.deepEqual(retried.map((t) => matched(t.value!)), [[true], [true]]);
  assert.equal(host.getStatus().state, "semantic");
  assert.equal(host.stats.overloadRejected, 2);
});

test("queued work from several frames continues on the new backend after a fail-over", async () => {
  // WebGPU: self-test ok, then fails; CPU takes over. Every embed is held until released.
  const h = makeHost({ manual: true, failAfter: { webgpu: 1 } });
  const replies = ["a", "b", "c"].map((f) => track(h.host.classify(req([`Bitcoin rallies again today, from ${f}`], 1, `frame-${f}`))));
  await drain(h.workers, replies);
  assert.deepEqual(replies.map((t) => verdicts(t.value!)), [[[true, "semantic"]], [[true, "semantic"]], [[true, "semantic"]]]);
  assert.ok(replies.every((t) => t.value!.ok && t.value!.engine.backend === "cpu"));
});

test("an unexpected exception in a job is answered and does not stall the queue", async () => {
  let throwOnce = true;
  const host = new EngineHost({
    createWorker: () => new FakeWorker({}, []),
    assetUrl: (p) => p,
    backends: async () => ["cpu"],
    loadModelMeta: async () => META,
    onStatus: () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("status listener failed");
      }
    },
    now: () => Date.now(),
  });
  const replies = [host.classify(req(["Bitcoin rallies again today"], 1, "x")), host.classify(req(["Bitcoin rallies again today, news"], 1, "y"))];
  const settled = await Promise.race([Promise.all(replies), until(() => false).then(() => null, () => null)]);
  assert.ok(settled, "every request settles");
  const [r1] = settled;
  assert.ok(r1 && !r1.ok && /status listener failed/.test(r1.error), JSON.stringify(r1));
});

// ── Sibling veto (siblings.ts) ───────────────────────────────────────────────

test("a text closer to a sibling subject of the topic is not matched; keyword matches still are", async () => {
  const { host, workers } = makeHost({}, ["cpu"]);
  const r = await host.classify(req(["Shares in crypto miners fall sharply", "Bitcoin rallies again today", "Cryptocurrency shares slide"]));
  assert.ok(r.ok);
  // "Shares …": margin 0.5 over the background, but closer to "stock market" (0.87 > 1.3 × 0.5).
  assert.deepEqual(r.decisions.map((d) => [d.matched, d.via, d.rivalled]), [[false, null, true], [true, "semantic", false], [true, "lexical", true]]);
  assert.ok(!workers[0]!.embedTexts.some((b) => b.includes(SIBLING_PHRASES[0]!)), "precomputed sibling vectors from model.json are used");
});

test("a broad topic (closer to its group's label than to any member) gets no sibling veto", async () => {
  const { host } = makeHost({}, ["cpu"]);
  // "sports" equals the group label "sports" (and its member "skiing and winter sports") → broad → no rivals.
  const r = await host.classify(req(["Sports goal of the season"], 1, "1:0:a", [{ id: "s", text: "sports" }]));
  assert.ok(r.ok);
  assert.deepEqual(r.decisions.map((d) => [d.matched, d.via, d.rivalled]), [[true, "semantic", false]]);
});

test("sibling phrases are embedded at run time when model.json lacks them", async () => {
  const workers: FakeWorker[] = [];
  const host = new EngineHost({
    createWorker: () => {
      const w = new FakeWorker({}, []);
      workers.push(w);
      return w;
    },
    assetUrl: (p) => p,
    backends: async () => ["cpu"],
    loadModelMeta: async () => ({ id: META.id, selftest: META.selftest, background: META.background }),
    onStatus: () => {},
    now: () => Date.now(),
  });
  const r = await host.classify(req(["Shares in crypto miners fall sharply"]));
  assert.deepEqual(matched(r), [false]);
  assert.ok(workers[0]!.embedTexts.some((b) => b.length === SIBLING_PHRASES.length && b[0] === SIBLING_PHRASES[0]));
});

test("compound topics embed their parts once and never treat a part as a rival", async () => {
  const { host, workers } = makeHost({}, ["cpu"]);
  const r = await host.classify(req(["Shares in crypto miners fall sharply"], 1, "1:0:a", [{ id: "t", text: "cryptocurrency and stock market" }]));
  assert.ok(r.ok);
  assert.equal(r.decisions[0]!.rivalled, false, "stock market is the user's own subject here");
  assert.ok(workers[0]!.embedTexts.some((b) => b.includes("cryptocurrency") && b.includes("stock market")), "parts are embedded with the job");
});
