// Bundle TypeScript and assemble the unpacked extension in dist/.
// Requires: pkg/ (npm run build:wasm), build/models/<model>/ (npm run setup:model)
// and build/vision/<id>/ (npm run setup:vision; downloaded and verified on demand).
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { DTYPE, LOCK, MODEL, MODEL_DIR, REPO, fail, run, sha256, step, weightsShaKey } from "./lib.mjs";
import { VISION_DIR, VISION_LOCK, verifyVisionModel } from "./setup-vision-model.mjs";
import { computeBackground } from "./vision-background.ts";

// --out <dir> builds elsewhere (e.g. alternative models for benchmarking).
const outIdx = process.argv.indexOf("--out");
const DIST = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(REPO, "dist");
const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const dev = process.argv.includes("--dev");

for (const f of ["pkg/clearscroll_engine.js", "pkg/clearscroll_engine_bg.wasm"]) {
  if (!fs.existsSync(path.join(REPO, f))) fail(`${f} missing — run: npm run build:wasm`);
}
const lock = LOCK.models[MODEL];
if (!lock) fail(`unknown model ${MODEL}`);
for (const f of ["weights.bin", "vocab.txt", "model.json"]) {
  if (!fs.existsSync(path.join(MODEL_DIR, f))) fail(`${path.relative(REPO, MODEL_DIR)}/${f} missing — run: npm run setup:model`);
}
step(`Verifying ${MODEL} (${DTYPE}) weights against tools/model_lock.json`);
if (!lock[weightsShaKey(DTYPE)]) fail(`no pinned ${weightsShaKey(DTYPE)} for ${MODEL} in tools/model_lock.json`);
if (sha256(path.join(MODEL_DIR, "weights.bin")) !== lock[weightsShaKey(DTYPE)]) fail("weights.bin sha256 does not match the lock file — re-run npm run setup:model");
if (sha256(path.join(MODEL_DIR, "vocab.txt")) !== lock.files["vocab.txt"]) fail("vocab.txt sha256 does not match the lock file");

step(`Verifying image model ${VISION_LOCK.id} against tools/vision_model_lock.json`);
if (verifyVisionModel().length) run("node", ["scripts/setup-vision-model.mjs"]);
const visionProblems = verifyVisionModel();
if (visionProblems.length) fail(`image model not verified:\n  ${visionProblems.join("\n  ")}`);
const ORT_WASM = "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm";
const ORT_GLUE = "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs";
for (const f of [ORT_WASM, ORT_GLUE]) if (!fs.existsSync(path.join(REPO, f))) fail(`${f} missing — run: npm ci`);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

step("Bundling TypeScript (esbuild)");
const common = { bundle: true, target: "chrome116", minify: !dev, sourcemap: dev ? "inline" : false, legalComments: "none", logLevel: "warning" };
const entries = [
  { in: "src/background/background.ts", out: "background/background.js", format: "esm" },
  // Content scripts are classic scripts, not modules.
  { in: "src/content/content.ts", out: "content/content.js", format: "iife" },
  { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen.js", format: "esm" },
  { in: "src/engine/engine.worker.ts", out: "offscreen/engine.worker.js", format: "esm" },
  { in: "src/vision/vision.worker.ts", out: "offscreen/vision.worker.js", format: "esm" },
  { in: "src/options/options.ts", out: "options/options.js", format: "esm" },
  { in: "src/popup/popup.ts", out: "popup/popup.js", format: "esm" },
];
await Promise.all(
  entries.map((e) =>
    esbuild.build({
      ...common,
      entryPoints: [path.join(REPO, e.in)],
      outfile: path.join(DIST, e.out),
      format: e.format,
      // ONNX Runtime's non-bundled build: its WebAssembly glue stays a separate
      // file (offscreen/vision/ort-wasm-simd-threaded.mjs) from which its
      // worker threads start.
      ...(e.in.includes("vision.worker") ? { conditions: ["onnxruntime-web-use-extern-wasm"] } : {}),
    })
  )
);

step("Copying static assets");
const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(DIST, to)), { recursive: true });
  fs.copyFileSync(path.join(REPO, from), path.join(DIST, to));
};
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "manifest.json"), "utf8"));
manifest.version = pkgJson.version;
fs.writeFileSync(path.join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
copy("src/content/content.css", "content/content.css");
copy("src/offscreen/offscreen.html", "offscreen/offscreen.html");
for (const page of ["options", "popup"]) {
  copy(`src/${page}/${page}.html`, `${page}/${page}.html`);
  copy(`src/${page}/${page}.css`, `${page}/${page}.css`);
}
copy("src/ui/common.css", "ui/common.css");
// Licence obligations: our licence, model/crate attributions, Apache-2.0 text.
copy("LICENSE", "LICENSE");
copy("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md");
copy("licenses/Apache-2.0.txt", "licenses/Apache-2.0.txt");
copy("licenses/THIRD_PARTY_LICENSES.txt", "licenses/THIRD_PARTY_LICENSES.txt");
copy("licenses/onnxruntime-LICENSE.txt", "licenses/onnxruntime-LICENSE.txt");
copy("licenses/onnxruntime-ThirdPartyNotices.txt", "licenses/onnxruntime-ThirdPartyNotices.txt");
for (const f of fs.readdirSync(path.join(REPO, "assets/icons"))) {
  if (f.endsWith(".png")) copy(`assets/icons/${f}`, `icons/${f}`);
}
// The worker and model live next to offscreen.html so relative URLs resolve.
copy("pkg/clearscroll_engine_bg.wasm", "offscreen/pkg/clearscroll_engine_bg.wasm");
for (const f of ["weights.bin", "vocab.txt", "model.json"]) copy(path.relative(REPO, path.join(MODEL_DIR, f)), `offscreen/model/${f}`);
// Image model (loaded only when image filtering is on) and the ONNX Runtime WebAssembly binary.
copy(ORT_WASM, "offscreen/vision/ort-wasm-simd-threaded.wasm");
copy(ORT_GLUE, "offscreen/vision/ort-wasm-simd-threaded.mjs");
for (const f of ["onnx/vision_model_quantized.onnx", "onnx/text_model_quantized.onnx", "tokenizer.json"]) copy(path.relative(REPO, path.join(VISION_DIR, f)), `offscreen/vision/${path.basename(f)}`);
step("Embedding the image filter's background prompts (ONNX Runtime WebAssembly, pinned text encoder)");
fs.writeFileSync(path.join(DIST, "offscreen/vision/background.json"), JSON.stringify(await computeBackground(VISION_DIR)));

const total = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? total(path.join(dir, d.name)) : fs.statSync(path.join(dir, d.name)).size), 0);
step(`dist/ assembled (${(total(DIST) / 1048576).toFixed(1)} MiB, model ${MODEL}, ${DTYPE} weights). Load it via chrome://extensions → Load unpacked.`);
