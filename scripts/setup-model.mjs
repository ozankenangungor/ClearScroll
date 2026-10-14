// Prepare verified model artifacts in build/models/<model>/.
// Creates .venv (pinned tools/requirements.txt) if needed, then runs
// tools/prepare_model.py. Skips work when existing artifacts verify.
import fs from "node:fs";
import path from "node:path";
import { DTYPE, LOCK, MODEL, REPO, capture, fail, run, step } from "./lib.mjs";

if (!LOCK.models[MODEL]) fail(`unknown model "${MODEL}"; choose one of: ${Object.keys(LOCK.models).join(", ")}`);
if (!["f16", "f32"].includes(DTYPE)) fail(`CLEARSCROLL_DTYPE must be f16 or f32, not "${DTYPE}"`);
const py = path.join(REPO, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

if (!fs.existsSync(py)) {
  step("Creating Python environment in .venv (CPU-only PyTorch, ~1 GB)");
  if (capture("uv", ["--version"])) {
    run("uv", ["venv", "-p", "3.13", ".venv"]);
    run("uv", ["pip", "install", "-p", py, "--require-hashes", "--index-strategy", "unsafe-best-match", "-r", "tools/requirements.lock"]);
  } else {
    const sys = capture("python3", ["--version"]) ? "python3" : "python";
    run(sys, ["-m", "venv", ".venv"], { hint: "Install Python 3.10–3.13 or uv." });
    run(py, ["-m", "pip", "install", "--require-hashes", "-r", "tools/requirements.lock"]);
  }
}

const verify = capture(py, ["tools/prepare_model.py", "--model", MODEL, "--dtype", DTYPE, "--verify-only"]);
if (verify !== null) {
  step(`Model artifacts for ${MODEL} (${DTYPE}) already present and verified`);
} else {
  step(`Preparing model ${MODEL} (${DTYPE}; download pinned revision, export, verify sha256)`);
  run(py, ["tools/prepare_model.py", "--model", MODEL, "--dtype", DTYPE]);
}
