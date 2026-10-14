// Regenerate docs/evaluation (shipped configuration) and the comparison
// variants referenced by docs/MODEL.md. Requires prepared f16 and f32 models
// for minilm-l6, minilm-l3 and bert-tiny, and the native CLI.
import { spawnSync } from "node:child_process";

const models = ["--models", "minilm-l6,minilm-l3,bert-tiny"];
const runs = [
  ["docs/evaluation", ["--dtype", "f16"]],
  ["docs/evaluation/variants/raw-cosine", ["--dtype", "f16", "--scoring", "raw"]],
  ["docs/evaluation/variants/v1-dataset-margin", ["--dtype", "f16", "--exclude-kinds", "neg-ui"]],
  ["docs/evaluation/variants/v1-dataset-raw-cosine", ["--dtype", "f16", "--exclude-kinds", "neg-ui", "--scoring", "raw"]],
  ["docs/evaluation/variants/f32-weights", ["--dtype", "f32"]],
];
for (const [out, opts] of runs) {
  const r = spawnSync("node", ["scripts/evaluate.ts", ...models, ...opts, "--out", out], { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) {
    console.error(`evaluation for ${out} failed`);
    process.exit(1);
  }
  console.log(`✔ ${out}  (${opts.join(" ")})`);
}
