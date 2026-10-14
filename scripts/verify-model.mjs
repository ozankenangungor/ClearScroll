// Verify prepared model artifacts against tools/model_lock.json.
//   node scripts/verify-model.mjs <model> <f16|f32> [...more model:dtype pairs as "model:dtype"]
import fs from "node:fs";
import path from "node:path";
import { LOCK, fail, modelDir, sha256, weightsShaKey } from "./lib.mjs";

const pairs = process.argv.slice(2).length ? process.argv.slice(2) : [`${process.env.CLEARSCROLL_MODEL ?? "minilm-l6"}:${process.env.CLEARSCROLL_DTYPE ?? "f16"}`];
for (const pair of pairs) {
  const [model, dtype] = pair.split(":");
  const lock = LOCK.models[model];
  if (!lock || !["f16", "f32"].includes(dtype)) fail(`bad model:dtype "${pair}"`);
  const dir = modelDir(model, dtype);
  for (const [file, want] of [["weights.bin", lock[weightsShaKey(dtype)]], ["vocab.txt", lock.files["vocab.txt"]]]) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) fail(`${p} missing`);
    const got = sha256(p);
    if (got !== want) fail(`${p}: sha256 ${got} != pinned ${want}`);
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
  if (meta.id !== model || (meta.dtype ?? "f32") !== dtype) fail(`${dir}/model.json describes ${meta.id}/${meta.dtype}`);
  console.log(`✔ ${model} (${dtype}) artifacts match the lock file`);
}
