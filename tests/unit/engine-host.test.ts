import assert from "node:assert/strict";
import { test } from "node:test";

import { EngineHost, type ModelMeta, type WorkerLike } from "../../src/offscreen/engine-host.ts";
import { BACKGROUND_TOPICS } from "../../src/shared/models.ts";
import type { Backend, ClassifyReply, EngineStatus, OffscreenClassify, WorkerRequest, WorkerResponse } from "../../src/shared/protocol.ts";

const DIM = 4;

/** Deterministic fake embedding: one orthogonal axis per cluster (crypto, sports, other). */
function fakeEmbed(text: string): number[] {
  const t = text.toLowerCase();
  return /crypto|bitcoin|coin/.test(t) ? [1, 0, 0, 0] : /sport|goal/.test(t) ? [0, 1, 0, 0] : [0, 0, 0, 1];
}

const SELFTEST = ["self test sentence one", "self test sentence two"];
const META: ModelMeta = {
  id: "minilm-l6",
  selftest: { texts: SELFTEST, embeddings: SELFTEST.map(fakeEmbed), max_abs_tol: 1e-3 },
  background: { topics: [...BACKGROUND_TOPICS], embeddings: BACKGROUND_TOPICS.map(fakeEmbed) },
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

function makeHost(b: Behaviour = {}, backends: Backend[] = ["webgpu", "cpu"]) {
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
  });
  return { host, log, workers, statuses };
}

function req(texts: string[], generation = 1, frameKey = "1:0:a", topics = [{ id: "t", text: "cryptocurrency" }]): OffscreenClassify {
  return { type: "off:classify", target: "offscreen", frameKey, generation, mode: "balanced", topics, texts };
}

const matched = (r: ClassifyReply) => (r.ok ? r.decisions.map((d) => d.matched) : r.error);
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
