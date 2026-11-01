/**
 * Embed the generic background prompts and the sibling phrases
 * (src/shared/vision.ts, src/shared/siblings.ts) with the pinned
 * text encoder at build time, using ONNX Runtime's WebAssembly backend — the
 * same runtime and model files the extension uses, so the vectors equal what
 * the extension would compute (the e2e parity test checks this). Saves the
 * extension ~4 s of CPU work at the first image of a session.
 */
import fs from "node:fs";
import path from "node:path";

import { SIBLING_PHRASES } from "../src/shared/siblings.ts";
import { meanVector, topicPrompts, VISION_BACKGROUND_PROMPTS, VISION_MODEL_ID, VISION_PROMPT_TEMPLATES, type PrecomputedBackground } from "../src/shared/vision.ts";
import { SIGLIP_CONTEXT, SiglipTokenizer } from "../src/vision/siglip-tokenizer.ts";

export async function computeBackground(modelDir: string): Promise<PrecomputedBackground> {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
  const tok = new SiglipTokenizer(JSON.parse(fs.readFileSync(path.join(modelDir, "tokenizer.json"), "utf8")).model);
  const session = await ort.InferenceSession.create(fs.readFileSync(path.join(modelDir, "onnx/text_model_quantized.onnx")), { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  // One prompt per run, like a single-topic batch in the extension.
  const embed = async (p: string): Promise<number[]> => {
    const out = await session.run({ input_ids: new ort.Tensor("int64", BigInt64Array.from(tok.encode(p), BigInt), [1, SIGLIP_CONTEXT]) });
    const v = Array.from(out.pooler_output!.data as Float32Array);
    const n = Math.hypot(...v);
    return v.map((x) => x / n);
  };
  const prompts = [...VISION_BACKGROUND_PROMPTS];
  const vectors: number[][] = [];
  for (const p of prompts) vectors.push(await embed(p));
  // Sibling phrases (siblings.ts), each embedded like a topic: the mean of its
  // templated prompts — the rivals of the image sibling veto (vision.ts).
  const sibVectors: number[][] = [];
  for (const phrase of SIBLING_PHRASES) {
    const ps = topicPrompts(phrase);
    const flat: number[] = [];
    for (const p of ps) flat.push(...(await embed(p)));
    // Six decimals: cosines change by < 1e-5, the file by half.
    sibVectors.push(Array.from(meanVector(Float32Array.from(flat), ps.length), (x) => Math.round(x * 1e6) / 1e6));
  }
  await session.release();
  return { model: VISION_MODEL_ID, prompts, vectors, siblings: { templates: [...VISION_PROMPT_TEMPLATES], phrases: [...SIBLING_PHRASES], vectors: sibVectors } };
}
