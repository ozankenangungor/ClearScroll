/**
 * Image-model checks that need the pinned model files (npm run setup:vision):
 *   - SigLIP tokenizer: token ids equal the reference tokenizer's for edge
 *     cases (tests/fixtures/siglip_tokenizer_parity.json);
 *   - int8 ONNX text encoder (ONNX Runtime, WebAssembly — the runtime the
 *     extension uses) vs the fp32 PyTorch reference embeddings.
 * Skipped when the files are absent, unless CLEARSCROLL_REQUIRE_VISION_MODEL=1
 * (CI's build job), where a missing model is a failure.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { SIGLIP_CONTEXT, SiglipTokenizer } from "../../src/vision/siglip-tokenizer.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const lock = JSON.parse(fs.readFileSync(path.join(REPO, "tools/vision_model_lock.json"), "utf8"));
const DIR = path.join(REPO, "build/vision", lock.id);
const present = fs.existsSync(path.join(DIR, "tokenizer.json")) && fs.existsSync(path.join(DIR, "onnx/text_model_quantized.onnx"));
const required = process.env.CLEARSCROLL_REQUIRE_VISION_MODEL === "1";
const skip = !present && !required ? "image model not prepared (npm run setup:vision)" : false;

test("SigLIP tokenizer reproduces the reference token ids", { skip }, () => {
  assert.ok(present, `${DIR} is missing (CLEARSCROLL_REQUIRE_VISION_MODEL=1)`);
  const tok = new SiglipTokenizer(JSON.parse(fs.readFileSync(path.join(DIR, "tokenizer.json"), "utf8")).model);
  const { cases } = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/siglip_tokenizer_parity.json"), "utf8"));
  assert.ok(cases.length >= 15);
  for (const c of cases) {
    const ids = tok.encode(c.text);
    assert.equal(ids.length, SIGLIP_CONTEXT);
    assert.deepEqual(ids, c.ids, JSON.stringify(c.text));
  }
});

test("int8 text encoder (ONNX Runtime WebAssembly) agrees with PyTorch fp32", { skip }, async () => {
  assert.ok(present, `${DIR} is missing (CLEARSCROLL_REQUIRE_VISION_MODEL=1)`);
  const ort = await import("onnxruntime-web");
  const tok = new SiglipTokenizer(JSON.parse(fs.readFileSync(path.join(DIR, "tokenizer.json"), "utf8")).model);
  const ref = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/siglip_embedding_parity.json"), "utf8"));
  const session = await ort.InferenceSession.create(fs.readFileSync(path.join(DIR, "onnx/text_model_quantized.onnx")));
  const prompts = Object.keys(ref.prompts);
  const out = await session.run({ input_ids: new ort.Tensor("int64", BigInt64Array.from(prompts.flatMap((p) => tok.encode(p)), BigInt), [prompts.length, SIGLIP_CONTEXT]) });
  const flat = out.pooler_output!.data as Float32Array;
  const dim = flat.length / prompts.length;
  prompts.forEach((p, i) => {
    const v = flat.subarray(i * dim, (i + 1) * dim);
    const r: number[] = ref.prompts[p];
    const cos = v.reduce((s, x, j) => s + x * r[j]!, 0) / Math.hypot(...v);
    // int8 quantisation error, not a different model: measured 0.968–0.989
    // on these prompts. (The decision rule was calibrated on the int8 outputs.)
    assert.ok(cos >= 0.96, `${p}: cosine to fp32 reference ${cos.toFixed(4)}`);
  });
});
