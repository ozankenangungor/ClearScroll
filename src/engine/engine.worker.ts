/**
 * engine.worker.ts — dedicated worker that owns one WebAssembly instance of
 * the Rust encoder. Spawned by the offscreen document (extension origin, so
 * the extension CSP with 'wasm-unsafe-eval' applies, not the page's CSP).
 *
 * The worker is intentionally dumb: it initialises once on a given backend
 * and turns batches of texts into embeddings. Requests are processed strictly
 * one at a time (a promise chain), because the Rust side keeps a single
 * engine and GPU readbacks must not interleave. Backend fallback and restarts
 * are decided by the offscreen document, which simply spawns a new worker.
 */

import initWasm, { embed_batch, init_engine } from "../../pkg/clearscroll_engine.js";
import type { WorkerRequest, WorkerResponse } from "../shared/protocol.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let initialised = false;
let memory: WebAssembly.Memory | null = null;
let chain: Promise<void> = Promise.resolve();

function reply(msg: WorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: HTTP ${res.status}`);
  return res;
}

async function handle(req: WorkerRequest): Promise<void> {
  if (req.type === "init") {
    if (initialised) {
      reply({ type: "init-failed", error: "worker already initialised" });
      return;
    }
    const start = performance.now();
    try {
      const exports = (await initWasm({ module_or_path: req.wasmUrl })) as { memory?: WebAssembly.Memory };
      memory = exports.memory ?? null;
      const [weights, vocab] = await Promise.all([
        fetchOk(req.weightsUrl).then((r) => r.arrayBuffer()),
        fetchOk(req.vocabUrl).then((r) => r.text()),
      ]);
      const before = memory?.buffer.byteLength ?? 0;
      const dim = await init_engine(new Uint8Array(weights), vocab, req.backend);
      initialised = true;
      reply({ type: "ready", backend: req.backend, dim, loadMs: Math.round(performance.now() - start), wasmMemoryBytes: memory?.buffer.byteLength ?? 0, wasmMemoryBeforeModelBytes: before });
    } catch (err) {
      reply({ type: "init-failed", error: errorText(err) });
    }
    return;
  }

  if (!initialised) {
    reply({ type: "embed-failed", id: req.id, error: "engine not initialised" });
    return;
  }
  const start = performance.now();
  try {
    const vectors = await embed_batch(req.texts);
    reply({ type: "embedded", id: req.id, vectors, ms: performance.now() - start, wasmMemoryBytes: memory?.buffer.byteLength ?? 0 }, [vectors.buffer]);
  } catch (err) {
    reply({ type: "embed-failed", id: req.id, error: errorText(err) });
  }
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  chain = chain.then(() => handle(req));
};
