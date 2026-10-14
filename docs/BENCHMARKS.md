# Benchmarks

All numbers were measured with the built extension (real model, real
offscreen document and worker) by `scripts/benchmark.ts`. Raw results,
including environment details, are in `docs/benchmarks/*.json`.

**Environment:** Intel Core i7-11800H (16 threads), 38 GiB RAM, Linux 7.2
(CachyOS), Playwright Chromium 156.0.8078.4. Headless runs only expose a
software WebGPU adapter (SwiftShader), which ClearScroll deliberately skips,
so they measure the WebAssembly CPU backend. The GPU run is headed with
`--ignore-gpu-blocklist` (Chrome blocklists this machine's GPUs for WebGPU by
default) and used the NVIDIA Ampere adapter (GeForce RTX 3050 Mobile).

## Reproduce

```bash
npm run build
node scripts/benchmark.ts --engine cpu --label minilm-l6-cpu-headless
# GPU (needs a display and a WebGPU-capable GPU):
node scripts/benchmark.ts --engine auto --headed --ignore-gpu-blocklist --label minilm-l6-webgpu-headed
# Other models:
CLEARSCROLL_MODEL=minilm-l3 node scripts/build.mjs --out build/dist-minilm-l3
node scripts/benchmark.ts --dist build/dist-minilm-l3 --engine cpu --label minilm-l3-cpu-headless
```

Method: warm latencies are medians of 7 runs with unique texts (no cache
hits), timed from the service worker sending `off:classify` to receiving the
decisions, i.e. including messaging, tokenisation, inference and decision
logic. Page metrics use a 2,000-post page and a `longtask`
PerformanceObserver; the engine is cold for the page run.

## Results

| Metric | MiniLM-L6, CPU | MiniLM-L6, WebGPU | MiniLM-L3, CPU | bert-tiny, CPU |
|---|---|---|---|---|
| Model weights | 85.5 MiB | 85.5 MiB | 65.2 MiB | 16.5 MiB |
| Engine WASM | 11.1 MiB | 11.1 MiB | 11.1 MiB | 11.1 MiB |
| Cold start: offscreen created → first answer | 513 ms | 888 ms | 341 ms | 147 ms |
| … of which worker init (WASM + weights) | 333 ms | 465 ms | 217 ms | 94 ms |
| Warm, 1 text | 47 ms | 18 ms | 26 ms | 7 ms |
| Warm, 24 texts (median / p95) | 666 / 743 ms | 62 / 76 ms | 330 / 353 ms | 41 / 45 ms |
| Warm, 64 texts | 1,625 ms | 158 ms | 822 ms | 99 ms |
| Per text at batch 24 | 27.7 ms | 2.6 ms | 13.7 ms | 1.7 ms |
| 24 texts of mixed length (1–4 sentences) | 1,609 ms | 194 ms | 744 ms | 91 ms |
| Same 24 texts again (cache hit) | 0.5 ms | 0.7 ms | 0.6 ms | 0.8 ms |
| 24 cached texts, new topic | 29 ms | 14 ms | 18 ms | 5 ms |
| WebAssembly linear memory | 219 MiB | 145 MiB | 179 MiB | 51 MiB |
| 2,000-post page: long tasks / blocking time (filtering on) | 0 / 0 ms | 0 / 0 ms | 0 / 0 ms | 0 / 0 ms |
| 2,000-post page: first blur / settled after navigation | 772 / 1,085 ms | 823 / 979 ms | 690 / 901 ms | 370 / 370 ms |

All four runs: commit `ce34796`. **Run-to-run variance on the GPU is
large on this laptop:** an earlier session with identical engine code measured
36 ms (24 texts) and 79 ms (mixed lengths) on the same adapter; three later
sessions all measured 62 ms and 193–196 ms. The table reports the committed
run. CPU results agreed within ~5 % across sessions.

Observations:

* **The page's main thread is not blocked.** With filtering on, the
  2,000-post page shows no long task (> 50 ms); scanning and DOM updates are
  incremental and inference runs in the offscreen worker.
* **WebGPU is ~11× faster per text** (up to ~18× in the faster GPU
  session) than the WASM CPU backend on this machine, but its cold start is slower (shader compilation; p95 of small
  batches includes first-time compilation for new shapes).
* **The cache makes topic changes cheap**: switching topics re-embeds only
  the topic, not the page.
* **Memory is the main cost.** The CPU backend holds float32 weights in WASM
  memory plus the transient copy of the downloaded file; WebAssembly memory
  never shrinks. Quantised (f16/int8) weights are the obvious next step but
  require re-running the parity and quality evaluation.

## Optimisations and their measured effect

Measured on MiniLM-L6, CPU backend, same machine (intermediate runs were not
kept as JSON; numbers are from the benchmark output at the time):

| Change | Before | After |
|---|---|---|
| WebAssembly SIMD (`+simd128`) | 95 ms/text (batch 24: 2,269 ms) | 32 ms/text (batch 24: 765 ms) |
| Length-sorted chunks of 8 on CPU (was 32, unsorted) | mixed-length 24: 2,523 ms; batch 64: 2,007 ms | 1,608 ms; 1,679 ms |
| First request after configuration limited to 8 texts | first blur 1,645 ms (cold) | 873 ms; all visible done at 1,443 ms |
| Shared engine in the offscreen document (vs per-tab worker) | per tab: one model load per tab (and semantic inference never started in the original design) | one load for all tabs |
| Embedding cache (LRU, 4,000 entries) | — | identical texts 0.6–1 ms; topic switch 12–26 ms for 24 texts |

Not adopted after consideration: WebAssembly threads (needs cross-origin
isolation of the offscreen document and a rayon port of the backend — large
complexity for a CPU fallback), `wasm-opt` (binaryen not part of the
toolchain yet; the 11 MiB engine is small next to the 85 MiB weights).
