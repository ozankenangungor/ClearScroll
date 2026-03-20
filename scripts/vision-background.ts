/**
 * Embed the generic background prompts (src/shared/vision.ts) with the pinned
 * text encoder at build time, using ONNX Runtime's WebAssembly backend — the
 * same runtime and model files the extension uses, so the vectors equal what
 * the extension would compute (the e2e parity test checks this). Saves the
 * extension ~4 s of CPU work at the first image of a session.
 */
import fs from "node:fs";
import path from "node:path";

import { VISION_BACKGROUND_PROMPTS, VISION_MODEL_ID, type PrecomputedBackground } from "../src/shared/vision.ts";
import { SIGLIP_CONTEXT, SiglipTokenizer } from "../src/vision/siglip-tokenizer.ts";

export async function computeBackground(modelDir: string): Promise<PrecomputedBackground> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  const tok = new SiglipTokenizer(JSON.parse(fs.readFileSync(path.join(modelDir, "tokenizer.json"), "utf8")).model);
  const session = await ort.InferenceSession.create(fs.readFileSync(path.join(modelDir, "onnx/text_model_quantized.onnx")), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  const prompts = [...VISION_BACKGROUND_PROMPTS];
  const vectors: number[][] = [];
  // One prompt per run, like a single-topic batch in the extension.
  for (const p of prompts) {
    const out = await session.run({ input_ids: new ort.Tensor("int64", BigInt64Array.from(tok.encode(p), BigInt), [1, SIGLIP_CONTEXT]) });
    const v = Array.from(out.pooler_output!.data as Float32Array);
    const n = Math.hypot(...v);
    vectors.push(v.map((x) => x / n));
  }
  await session.release();
  return { model: VISION_MODEL_ID, prompts, vectors };
}
