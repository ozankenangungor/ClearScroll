// Deterministic checks on the built extension. Exit code 1 on any failure.
//   node scripts/validate-dist.mjs [dist-dir]
import fs from "node:fs";
import path from "node:path";
import { LOCK, REPO, sha256 } from "./lib.mjs";

const DIST = path.resolve(process.argv[2] ?? path.join(REPO, "dist"));
const errors = [];
const notes = [];
const err = (m) => errors.push(m);
const rel = (p) => path.relative(DIST, p);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}
const exists = (p) => fs.existsSync(path.join(DIST, p.split("?")[0]));

if (!fs.existsSync(path.join(DIST, "manifest.json"))) {
  console.error(`✖ ${DIST}/manifest.json not found — run npm run build`);
  process.exit(1);
}
const files = walk(DIST);
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

// ── Manifest ──────────────────────────────────────────────────────────────
if (manifest.manifest_version !== 3) err("manifest_version must be 3");
if (manifest.name !== "ClearScroll") err(`manifest name is "${manifest.name}"`);
if (manifest.version !== pkg.version) err(`manifest version ${manifest.version} != package.json ${pkg.version}`);
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) err("manifest version is not a valid Chrome version string");
if (!manifest.description || manifest.description.length > 132) err("description missing or longer than 132 chars");
if (manifest.web_accessible_resources) err("web_accessible_resources must not be declared (exposes the extension to fingerprinting)");
const allowedPerms = ["offscreen", "scripting", "storage"];
for (const p of manifest.permissions ?? []) if (!allowedPerms.includes(p)) err(`unexpected permission "${p}"`);
const csp = manifest.content_security_policy?.extension_pages ?? "";
if (/'unsafe-eval'|'unsafe-inline'|https?:/.test(csp)) err(`extension CSP is too permissive: ${csp}`);
if (!csp.includes("'wasm-unsafe-eval'")) err("extension CSP must allow 'wasm-unsafe-eval' for the engine");

const referenced = [
  manifest.background?.service_worker,
  manifest.options_page,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  // Registered dynamically by background.js / created as offscreen document:
  "content/content.js",
  "content/content.css",
  "offscreen/offscreen.html",
  "offscreen/engine.worker.js",
  "offscreen/pkg/clearscroll_engine_bg.wasm",
  "offscreen/model/weights.bin",
  "offscreen/model/vocab.txt",
  "offscreen/model/model.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "licenses/Apache-2.0.txt",
].filter(Boolean);
for (const r of referenced) if (!exists(r)) err(`referenced file missing: ${r}`);

// ── HTML references ───────────────────────────────────────────────────────
for (const f of files.filter((f) => f.endsWith(".html"))) {
  const html = fs.readFileSync(f, "utf8");
  if (/<script(?![^>]*\bsrc=)[^>]*>\s*\S/.test(html)) err(`${rel(f)}: inline <script> is not allowed`);
  if (/\son[a-z]+\s*=/.test(html)) err(`${rel(f)}: inline event handler attribute`);
  for (const [, url] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    if (/^https?:|^\/\//.test(url)) err(`${rel(f)}: remote resource ${url}`);
    else if (!fs.existsSync(path.resolve(path.dirname(f), url))) err(`${rel(f)}: missing ${url}`);
  }
}

// ── JavaScript: no remote code, no eval ───────────────────────────────────
const ALLOWED_URL_STRINGS = new Set(["http://*/*", "https://*/*"]);
for (const f of files.filter((f) => f.endsWith(".js"))) {
  const js = fs.readFileSync(f, "utf8");
  if (/\beval\s*\(|new\s+Function\s*\(/.test(js)) err(`${rel(f)}: uses eval/new Function`);
  if (/importScripts\s*\(\s*["'`]https?:/.test(js) || /import\s*\(\s*["'`]https?:/.test(js)) err(`${rel(f)}: imports remote code`);
  for (const [url] of js.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
    // `new URL(\`http://${host}/\`)` in sites.ts normalises host names (IDNA); never fetched.
    if (/^http:\/\/\$\{\w+\}\/$/.test(url)) continue;
    if (!ALLOWED_URL_STRINGS.has(url)) err(`${rel(f)}: contains URL ${url} (verify it is not fetched)`);
  }
}

// ── Engine and model ──────────────────────────────────────────────────────
const wasmPath = path.join(DIST, "offscreen/pkg/clearscroll_engine_bg.wasm");
if (fs.existsSync(wasmPath)) {
  const head = fs.readFileSync(wasmPath).subarray(0, 4);
  if (!head.equals(Buffer.from([0, 0x61, 0x73, 0x6d]))) err("clearscroll_engine_bg.wasm is not a WebAssembly binary");
}
const metaPath = path.join(DIST, "offscreen/model/model.json");
if (fs.existsSync(metaPath)) {
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const lock = LOCK.models[meta.id];
  if (!lock) err(`model.json id "${meta.id}" is not in tools/model_lock.json`);
  else {
    if (sha256(path.join(DIST, "offscreen/model/weights.bin")) !== lock.weights_sha256) err("weights.bin sha256 does not match the lock file");
    if (sha256(path.join(DIST, "offscreen/model/vocab.txt")) !== lock.files["vocab.txt"]) err("vocab.txt sha256 does not match the lock file");
    notes.push(`model ${meta.id} (${lock.repo}@${lock.revision.slice(0, 12)}, ${lock.license})`);
  }
  if (!meta.selftest?.embeddings?.length) err("model.json has no self-test reference embeddings");
}

// ── No development artifacts ──────────────────────────────────────────────
for (const f of files) {
  const r = rel(f);
  if (/\.(map|ts|tsx|rs|py|d\.ts)$/.test(r) || (r.endsWith(".md") && r !== "THIRD_PARTY_NOTICES.md") || /(^|\/)(node_modules|\.git|\.DS_Store)/.test(r)) err(`development artifact in dist: ${r}`);
}
for (const f of files.filter((f) => f.endsWith(".js"))) {
  if (/sourceMappingURL/.test(fs.readFileSync(f, "utf8"))) err(`${rel(f)}: contains a source map reference (dev build?)`);
}

const size = files.reduce((n, f) => n + fs.statSync(f).size, 0);
const big = files.map((f) => [rel(f), fs.statSync(f).size]).sort((a, b) => b[1] - a[1]).slice(0, 4);
console.log(`dist: ${files.length} files, ${(size / 1048576).toFixed(1)} MiB; largest: ${big.map(([f, s]) => `${f} ${(s / 1048576).toFixed(1)} MiB`).join(", ")}`);
for (const n of notes) console.log(`  · ${n}`);
if (errors.length) {
  for (const e of errors) console.error(`✖ ${e}`);
  console.error(`\n${errors.length} problem(s) found.`);
  process.exit(1);
}
console.log("✔ dist validated");
