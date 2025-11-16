/**
 * brain.worker.ts — Off-thread inference worker
 *
 * Runs the Burn/WebGPU WASM model in a dedicated worker thread.
 * Implements an init queue so messages arriving before init() completes
 * are buffered and processed once the engine is ready.
 */

export {}; // Force TypeScript to treat this as a module

const TAG = "[IdeaBlocker/Worker]";

// ── Types ──────────────────────────────────────────────────────────────

interface ClassifyRequest {
  id: number;
  texts: string[];
}

interface ClassifyResponse {
  id: number;
  results: boolean[];
}

interface ErrorResponse {
  id: number;
  error: string;
}

// ── State ──────────────────────────────────────────────────────────────

let wasmModule: {
  init: () => Promise<void>;
  classify_batch: (texts: string[]) => boolean[];
} | null = null;

let ready = false;
const pendingQueue: ClassifyRequest[] = [];

// ── Init ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  console.log(TAG, "Initializing...");

  try {
    // Resolve paths relative to this worker's location (chrome-extension://...)
    const workerURL = new URL(self.location.href);
    const baseURL = workerURL.href.replace(/\/[^/]*$/, "/");
    const wasmJsURL = baseURL + "pkg/text_classifier_wasm.js";

    // Dynamic import — loads the ES module produced by wasm-pack
    const wasm = await import(/* @vite-ignore */ wasmJsURL);

    // Initialize the WASM binary (wasm-pack default export loads the .wasm file)
    await wasm.default();

    // Initialize the Burn WebGPU backend + model
    await wasm.init();

    wasmModule = {
      init: wasm.init,
      classify_batch: wasm.classify_batch,
    };

    ready = true;
    console.log(TAG, "WASM init complete. WebGPU backend ready.");

    // Drain any messages that arrived during initialization
    drainQueue();
  } catch (err) {
    console.error(TAG, "Init failed:", err);
    // Respond to all queued requests with the error
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

function processRequest(req: ClassifyRequest): void {
  try {
    const results = wasmModule!.classify_batch(req.texts) as unknown as boolean[];
    self.postMessage({ id: req.id, results } satisfies ClassifyResponse);
  } catch (err) {
    console.error(TAG, `classify_batch error (id=${req.id}):`, err);
    self.postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ErrorResponse);
  }
}

// ── Message handler ────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<ClassifyRequest>) => {
  const req = event.data;

  if (!ready) {
    // Engine still initializing — queue for later
    pendingQueue.push(req);
    return;
  }

  processRequest(req);
};

// ── Kick off initialization immediately ────────────────────────────────
bootstrap();
