// Download the pinned image model (tools/vision_model_lock.json) into
// build/vision/<id>/ and verify every file's sha256. Node only; no Python.
// Skips files that already verify. Fails on any size or hash mismatch, so a
// changed upstream file can never be packaged silently.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, fail, sha256, step } from "./lib.mjs";

export const VISION_LOCK = JSON.parse(fs.readFileSync(path.join(REPO, "tools/vision_model_lock.json"), "utf8"));
export const VISION_DIR = path.join(REPO, "build/vision", VISION_LOCK.id);

export function verifyVisionModel(dir = VISION_DIR) {
  const problems = [];
  for (const [file, { sha256: want, size }] of Object.entries(VISION_LOCK.files)) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) problems.push(`${file}: missing`);
    else if (fs.statSync(p).size !== size) problems.push(`${file}: size ${fs.statSync(p).size} != ${size}`);
    else if (sha256(p) !== want) problems.push(`${file}: sha256 mismatch`);
  }
  return problems;
}

async function download(file, { sha256: want, size }) {
  const url = `https://huggingface.co/${VISION_LOCK.repo}/resolve/${VISION_LOCK.revision}/${file}`;
  const dest = path.join(VISION_DIR, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const hash = createHash("sha256");
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      let n = 0;
      for await (const chunk of res.body) {
        n += chunk.length;
        if (n > size) throw new Error(`more than the pinned ${size} bytes`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      const got = hash.digest("hex");
      if (n !== size || got !== want) {
        fs.rmSync(tmp, { force: true });
        fail(`${file}: downloaded ${n} bytes with sha256 ${got}; the lock file pins ${size} bytes / ${want}. Refusing to use a changed upstream file.`);
      }
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      if (attempt >= 3) fail(`${file}: download failed: ${err.message}`);
      console.warn(`  ${file}: ${err.message}; retrying`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const verifyOnly = process.argv.includes("--verify-only");
  const before = verifyVisionModel();
  if (before.length === 0) {
    step(`Image model ${VISION_LOCK.id} already present and verified (${path.relative(REPO, VISION_DIR)})`);
  } else if (verifyOnly) {
    fail(`image model not verified:\n  ${before.join("\n  ")}\nRun: npm run setup:vision`);
  } else {
    step(`Downloading image model ${VISION_LOCK.repo}@${VISION_LOCK.revision.slice(0, 12)} (${VISION_LOCK.license})`);
    for (const [file, spec] of Object.entries(VISION_LOCK.files)) {
      const p = path.join(VISION_DIR, file);
      if (fs.existsSync(p) && fs.statSync(p).size === spec.size && sha256(p) === spec.sha256) continue;
      console.log(`  ${file} (${(spec.size / 1048576).toFixed(1)} MiB)`);
      await download(file, spec);
    }
    const after = verifyVisionModel();
    if (after.length) fail(after.join("\n"));
    step(`Image model verified in ${path.relative(REPO, VISION_DIR)}`);
  }
}
