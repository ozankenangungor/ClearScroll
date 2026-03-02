/**
 * brain.worker.ts — Off-thread semantic inference worker
 *
 * Runs the Burn/WebGPU WASM embedder in a dedicated worker thread.
 * Supports two message types:
 *   - SET_TARGET: embed a user prompt and store the reference vector
 *   - COMPARE:    compare incoming texts against the reference vector
 */

export {}; // Force TypeScript to treat this as a module

const TAG = "[IdeaBlocker/Worker]";

// ── Types ──────────────────────────────────────────────────────────────

interface SetTargetRequest {
  type: "SET_TARGET";
  id: number;
  target: string;
}

interface CompareRequest {
  type: "COMPARE";
  id: number;
  texts: string[];
}

type WorkerRequest = SetTargetRequest | CompareRequest;

interface SetTargetResponse {
  id: number;
  type: "SET_TARGET";
  ok: true;
}

interface CompareResponse {
  id: number;
  type: "COMPARE";
  results: boolean[];
}

interface ErrorResponse {
  id: number;
  error: string;
}

// ── State ──────────────────────────────────────────────────────────────

let wasmModule: {
  init: () => Promise<void>;
  embed_text: (text: string) => Float32Array;
  compare_batch: (
    reference: Float32Array,
    texts: string[],
    threshold: number
  ) => boolean[];
} | null = null;

let ready = false;
let referenceEmbedding: Float32Array | null = null;
const SIMILARITY_THRESHOLD = 0.6;

const pendingQueue: WorkerRequest[] = [];

// ── Init ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  console.log(TAG, "Initializing...");

  try {
    const workerURL = new URL(self.location.href);
    const baseURL = workerURL.href.replace(/\/[^/]*$/, "/");
    const wasmJsURL = baseURL + "pkg/text_classifier_wasm.js";

    const wasm = await import(/* @vite-ignore */ wasmJsURL);
    await wasm.default();
    await wasm.init();

    wasmModule = {
      init: wasm.init,
      embed_text: wasm.embed_text,
      compare_batch: wasm.compare_batch,
    };

    ready = true;
    console.log(TAG, "WASM init complete. Semantic embedder ready.");

    drainQueue();
  } catch (err) {
    console.error(TAG, "Init failed:", err);
    for (const req of pendingQueue) {
      self.postMessage({
        id: req.id,
        error: `Init failed: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies ErrorResponse);
    }
    pendingQueue.length = 0;
  }
}

// ── Queue drain ────────────────────────────────────────────────────────

function drainQueue(): void {
  while (pendingQueue.length > 0) {
    const req = pendingQueue.shift()!;
    processRequest(req);
  }
}

// ── Request processing ─────────────────────────────────────────────────

function processRequest(req: WorkerRequest): void {
  try {
    if (req.type === "SET_TARGET") {
      if (req.target.trim().length === 0) {
        // Empty target clears the filter
        referenceEmbedding = null;
        console.log(TAG, "Target cleared — filtering disabled.");
      } else {
        referenceEmbedding = wasmModule!.embed_text(req.target);
        console.log(TAG, `Target set: "${req.target}" → embedding[${referenceEmbedding.length}]`);
      }
      self.postMessage({ id: req.id, type: "SET_TARGET", ok: true } satisfies SetTargetResponse);
    } else if (req.type === "COMPARE") {
      if (!referenceEmbedding) {
        // No target set — nothing should be blocked
        const results = new Array<boolean>(req.texts.length).fill(false);
        self.postMessage({ id: req.id, type: "COMPARE", results } satisfies CompareResponse);
        return;
      }

      const results = wasmModule!.compare_batch(
        referenceEmbedding,
        req.texts,
        SIMILARITY_THRESHOLD
      ) as unknown as boolean[];
      self.postMessage({ id: req.id, type: "COMPARE", results } satisfies CompareResponse);
    }
  } catch (err) {
    console.error(TAG, `Error processing ${req.type} (id=${req.id}):`, err);
    self.postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ErrorResponse);
  }
}

// ── Message handler ────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  if (!ready) {
    pendingQueue.push(req);
    return;
  }

  processRequest(req);
};

// ── Kick off initialization immediately ────────────────────────────────
bootstrap();
