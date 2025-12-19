// Shared helpers for build scripts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LOCK = JSON.parse(fs.readFileSync(path.join(REPO, "tools/model_lock.json"), "utf8"));

/** Model shipped in the extension; override with CLEARSCROLL_MODEL. */
export const MODEL = process.env.CLEARSCROLL_MODEL || "minilm-l6";
export const MODEL_DIR = path.join(REPO, "build/models", MODEL);

export function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

export function step(msg) {
  console.log(`==> ${msg}`);
}

/** Run a command, streaming output; exit on failure. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: REPO, ...opts });
  if (r.error?.code === "ENOENT") fail(`'${cmd}' not found on PATH. ${opts.hint ?? ""}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited with ${r.status}`);
}

/** Run a command and capture stdout, or return null if it cannot run. */
export function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function lockedCrateVersion(name) {
  const lock = fs.readFileSync(path.join(REPO, "Cargo.lock"), "utf8");
  const m = lock.match(new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`));
  return m ? m[1] : null;
}
