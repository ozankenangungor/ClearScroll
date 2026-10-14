// Bundle TypeScript and assemble the unpacked extension in dist/.
// Requires: pkg/ (npm run build:wasm) and build/models/<model>/ (npm run setup:model).
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { LOCK, MODEL, MODEL_DIR, REPO, fail, sha256, step } from "./lib.mjs";

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
  if (!fs.existsSync(path.join(MODEL_DIR, f))) fail(`build/models/${MODEL}/${f} missing — run: npm run setup:model`);
}
step(`Verifying ${MODEL} weights against tools/model_lock.json`);
if (sha256(path.join(MODEL_DIR, "weights.bin")) !== lock.weights_sha256) fail("weights.bin sha256 does not match the lock file — re-run npm run setup:model");
if (sha256(path.join(MODEL_DIR, "vocab.txt")) !== lock.files["vocab.txt"]) fail("vocab.txt sha256 does not match the lock file");

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
  { in: "src/options/options.ts", out: "options/options.js", format: "esm" },
  { in: "src/popup/popup.ts", out: "popup/popup.js", format: "esm" },
];
await Promise.all(entries.map((e) => esbuild.build({ ...common, entryPoints: [path.join(REPO, e.in)], outfile: path.join(DIST, e.out), format: e.format })));

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
for (const f of fs.readdirSync(path.join(REPO, "assets/icons"))) {
  if (f.endsWith(".png")) copy(`assets/icons/${f}`, `icons/${f}`);
}
// The worker and model live next to offscreen.html so relative URLs resolve.
copy("pkg/clearscroll_engine_bg.wasm", "offscreen/pkg/clearscroll_engine_bg.wasm");
for (const f of ["weights.bin", "vocab.txt", "model.json"]) copy(`build/models/${MODEL}/${f}`, `offscreen/model/${f}`);

const total = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? total(path.join(dir, d.name)) : fs.statSync(path.join(dir, d.name)).size), 0);
step(`dist/ assembled (${(total(DIST) / 1048576).toFixed(1)} MiB, model ${MODEL}). Load it via chrome://extensions → Load unpacked.`);
