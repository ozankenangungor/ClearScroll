/**
 * vision.worker.ts — dedicated worker that owns the SigLIP image and text
 * encoders (ONNX Runtime Web, WebAssembly CPU backend). Spawned by the
 * offscreen document, so the extension CSP ('wasm-unsafe-eval') applies, and
 * fully separate from the Rust text engine's worker: neither can block or
 * crash the other.
 *
 * One bundle, two roles chosen at init: "image" (the image encoder; decodes
 * and preprocesses pictures) or "text" (the text encoder and tokenizer, for
 * topic prompts). The host runs them as separate workers so the text encoder
 * (≈ 0.35 GB once loaded) can be shut down when no new topic needs it —
 * WebAssembly memory is only returned when its worker ends.
 *
 * Like engine.worker.ts it is deliberately dumb: it loads the packaged model
 * files from extension URLs and returns embeddings. Scheduling, caching,
 * limits and decisions live in src/offscreen/vision-host.ts. Requests are
 * processed one at a time.
 */

import * as ort from "onnxruntime-web/wasm";

import type { VisionWorkerRequest, VisionWorkerResponse } from "../shared/vision.ts";
import { INPUT_SIZE, drawToRgb, rgbToTensor } from "./preprocess.ts";
import { SiglipTokenizer, SIGLIP_CONTEXT, type UnigramModel } from "./siglip-tokenizer.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let session: ort.InferenceSession | null = null;
let role: "image" | "text" | null = null;
let tokenizer: SiglipTokenizer | null = null;
let chain: Promise<void> = Promise.resolve();

function reply(msg: VisionWorkerResponse, transfer: Transferable[] = []): void {
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

function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (!(n > 0) || !Number.isFinite(n)) throw new Error("embedding has no finite norm");
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

async function embedImageTensor(data: Float32Array): Promise<Float32Array> {
  const input = new ort.Tensor("float32", data, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const out = await session!.run({ pixel_values: input });
  // SigLIP has no projection head: the pooled output is the embedding.
  const emb = out.pooler_output;
  if (!emb) throw new Error("vision model returned no pooler_output");
  const v = new Float32Array(emb.data as Float32Array);
  for (const t of Object.values(out)) t.dispose();
  return l2normalize(v);
}

/**
 * One prompt per run, never batched: the int8 model quantises activations
 * dynamically with one scale per tensor, so a batched prompt's embedding
 * would depend on the other prompts in its batch. Batch size 1 makes every
 * prompt's embedding a function of the prompt alone (and equal to the
 * build-time background vectors, computed the same way).
 */
async function embedTexts(prompts: string[]): Promise<Float32Array> {
  const parts: Float32Array[] = [];
  for (const p of prompts) {
    // Every sequence is exactly SIGLIP_CONTEXT long (padded by the tokenizer).
    const ids = BigInt64Array.from(tokenizer!.encode(p), BigInt);
    const out = await session!.run({ input_ids: new ort.Tensor("int64", ids, [1, SIGLIP_CONTEXT]) });
    const emb = out.pooler_output;
    if (!emb) throw new Error("text model returned no pooler_output");
    parts.push(l2normalize(new Float32Array(emb.data as Float32Array)));
    for (const t of Object.values(out)) t.dispose();
  }
  const all = new Float32Array(parts.reduce((n, v) => n + v.length, 0));
  let off = 0;
  for (const v of parts) {
    all.set(v, off);
    off += v.length;
  }
  return all;
}

/** Decode an encoded image (fetched by the host) and preprocess it. */
async function decodeBlob(blob: Blob, maxPixels: number): Promise<Uint8Array> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch (err) {
    throw Object.assign(new Error(`could not decode image: ${errorText(err)}`), { reason: "decode" });
  }
  try {
    if (bitmap.width * bitmap.height > maxPixels) {
      throw Object.assign(new Error(`image too large (${bitmap.width}×${bitmap.height})`), { reason: "too-large" });
    }
    return drawToRgb(bitmap);
  } finally {
    bitmap.close();
  }
}

async function handle(req: VisionWorkerRequest): Promise<void> {
  if (req.type === "init") {
    const start = performance.now();
    try {
      if (session) throw new Error("worker already initialised");
      ort.env.wasm.wasmPaths = { wasm: req.ortWasmUrl };
      // Threads need cross-origin isolation (SharedArrayBuffer); a single
      // thread keeps the extension pages free of COOP/COEP requirements.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      const opts: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
      if (req.role === "text") {
        if (!req.tokenizerUrl) throw new Error("text role needs a tokenizer");
        const tok = (await fetchOk(req.tokenizerUrl).then((r) => r.json())) as { model: UnigramModel };
        tokenizer = new SiglipTokenizer(tok.model);
      }
      const bytes = await fetchOk(req.modelUrl).then((r) => r.arrayBuffer());
      session = await ort.InferenceSession.create(new Uint8Array(bytes), opts);
      role = req.role;
      reply({ type: "ready", loadMs: Math.round(performance.now() - start) });
    } catch (err) {
      session = null;
      reply({ type: "init-failed", error: errorText(err) });
    }
    return;
  }

  if (!session || role !== (req.type === "text" ? "text" : "image")) {
    reply({ type: "failed", id: req.id, error: `no ${req.type === "text" ? "text" : "image"} model in this worker`, reason: "inference" });
    return;
  }
  const start = performance.now();
  if (req.type === "text") {
    try {
      const vectors = await embedTexts(req.prompts);
      reply({ type: "text-done", id: req.id, vectors, ms: performance.now() - start }, [vectors.buffer]);
    } catch (err) {
      reply({ type: "failed", id: req.id, error: errorText(err), reason: "inference" });
    }
    return;
  }

  let rgb: Uint8Array;
  try {
    rgb = req.rgb ?? (await decodeBlob(req.blob!, req.maxPixels));
  } catch (err) {
    const reason = (err as { reason?: "decode" | "too-large" }).reason ?? "decode";
    reply({ type: "failed", id: req.id, error: errorText(err), reason });
    return;
  }
  try {
    const vector = await embedImageTensor(rgbToTensor(rgb));
    reply({ type: "image-done", id: req.id, vector, ms: performance.now() - start }, [vector.buffer]);
  } catch (err) {
    reply({ type: "failed", id: req.id, error: errorText(err), reason: "inference" });
  }
}

scope.onmessage = (event: MessageEvent<VisionWorkerRequest>) => {
  const req = event.data;
  chain = chain.then(() => handle(req));
};
