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
fs.rmSync(path.join(REPO, "pkg"), { recursive: true, force: true });
run("wasm-bindgen", ["--target", "web", "--no-typescript", "--out-dir", "pkg", "--out-name", "clearscroll_engine", wasm]);
// Hand-written declarations for the two exports we use (stable across builds).
fs.writeFileSync(path.join(REPO, "pkg/clearscroll_engine.d.ts"), `export default function init(opts: { module_or_path: string | URL }): Promise<unknown>;
export function init_engine(weights: Uint8Array, vocab: string, backend: string): Promise<number>;
export function embed_batch(texts: string[]): Promise<Float32Array>;
`);
const size = fs.statSync(path.join(REPO, "pkg/clearscroll_engine_bg.wasm")).size;
step(`pkg/clearscroll_engine_bg.wasm: ${(size / 1048576).toFixed(2)} MiB`);
