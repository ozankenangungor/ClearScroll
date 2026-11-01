// Compile the Rust engine to WebAssembly and generate JS bindings in pkg/.
import fs from "node:fs";
import path from "node:path";
import { REPO, capture, fail, lockedCrateVersion, run, step } from "./lib.mjs";

const want = lockedCrateVersion("wasm-bindgen");
if (!want) fail("wasm-bindgen not found in Cargo.lock");
const have = capture("wasm-bindgen", ["--version"])?.split(" ")[1];
if (have !== want) {
  fail(`wasm-bindgen CLI ${have ?? "is not installed"}; Cargo.lock requires ${want}.\n  Install: cargo install wasm-bindgen-cli --version ${want} --locked`);
}
const targets = capture("rustup", ["target", "list", "--installed"]);
if (targets !== null && !targets.split("\n").includes("wasm32-unknown-unknown")) {
  fail("Rust target wasm32-unknown-unknown missing. Install: rustup target add wasm32-unknown-unknown");
}

step("Compiling Rust → wasm32-unknown-unknown (release)");
run("cargo", ["build", "--lib", "--locked", "--release", "--target", "wasm32-unknown-unknown"], { hint: "Install Rust from https://rustup.rs" });

step(`Generating bindings with wasm-bindgen ${want}`);
const wasm = path.join(REPO, "target/wasm32-unknown-unknown/release/clearscroll_engine.wasm");
// pkg/clearscroll_engine.d.ts is tracked: hand-written declarations for the
// two exports we use (stable across builds), needed by typecheck before any
// build. Everything else in pkg/ is generated and replaced.
const pkg = path.join(REPO, "pkg");
for (const f of fs.existsSync(pkg) ? fs.readdirSync(pkg) : []) {
  if (f !== "clearscroll_engine.d.ts") fs.rmSync(path.join(pkg, f), { recursive: true, force: true });
}
run("wasm-bindgen", ["--target", "web", "--no-typescript", "--out-dir", "pkg", "--out-name", "clearscroll_engine", wasm]);
const size = fs.statSync(path.join(REPO, "pkg/clearscroll_engine_bg.wasm")).size;
step(`pkg/clearscroll_engine_bg.wasm: ${(size / 1048576).toFixed(2)} MiB`);
