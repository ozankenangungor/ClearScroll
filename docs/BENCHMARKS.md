# Benchmarks

All numbers were measured with the built extension (real model, real
offscreen document and worker) by `scripts/benchmark.ts`. Raw results with
environment details are in `docs/benchmarks/*.json`; every run below is from
commit `89330b1` (f16 weights, margin scoring).

**Environment:** Intel Core i7-11800H (16 threads), 38 GiB RAM, Linux 7.2
(CachyOS), Playwright Chromium 156.0.8078.4 and Google Chrome 153.0.8010.47
(stable). On this machine both browsers expose only the SwiftShader software
WebGPU adapter by default (Chrome blocklists the GPU drivers for WebGPU), so
ClearScroll correctly runs on the WebAssembly CPU backend. The WebGPU runs
use a headed browser with `--ignore-gpu-blocklist`, which exposes the NVIDIA
Ampere GPU (GeForce RTX 3050 Mobile); the adapter actually used is recorded
in each JSON file.

## Reproduce

```bash
npm run build
node scripts/benchmark.ts --engine cpu --label minilm-l6-f16-cpu-chromium
node scripts/benchmark.ts --browser chrome --engine auto --label minilm-l6-f16-auto-chrome-stable
# Real GPU (needs a display and a WebGPU-capable GPU):
node scripts/benchmark.ts --engine auto --headed --ignore-gpu-blocklist --label minilm-l6-f16-webgpu-chromium
# Other builds:
CLEARSCROLL_DTYPE=f32 node scripts/build.mjs --out build/dist-f32
CLEARSCROLL_MODEL=minilm-l3 node scripts/build.mjs --out build/dist-minilm-l3
node scripts/benchmark.ts --dist build/dist-minilm-l3 --engine cpu --label minilm-l3-f16-cpu-chromium
```

Method: warm latencies are medians of 7 runs with unique texts (no cache
hits), timed from the service worker sending `off:classify` to receiving the
decisions — messaging, tokenisation, inference, background margins and
decision logic included. Page metrics use a 2,000-post page with a
`longtask` PerformanceObserver; the engine is cold for the page run.

## MiniLM-L6 (shipped model)

| Metric | CPU, Chromium | CPU, Chrome stable (default flags) | WebGPU, Chromium | WebGPU, Chrome stable | CPU, Chromium, **f32** weights |
|---|---|---|---|---|---|
| Weights in package | 42.8 MiB | 42.8 MiB | 42.8 MiB | 42.8 MiB | 85.5 MiB |
| Cold start: offscreen created → first answer | 391 ms | 393 ms | 834 ms | 951 ms | 580 ms |
| … of which worker init (WASM + weights) | 192 ms | 200 ms | 423 ms | 497 ms | 361 ms |
| Warm, 1 text | 41 ms | 40 ms | 15 ms | 16 ms | 43 ms |
| Warm, 24 texts (median / p95) | 619 / 684 ms | 687 / 772 ms | 44 / 71 ms | 42 / 73 ms | 698 / 817 ms |
| Warm, 64 texts | 1,583 ms | 1,703 ms | 110 ms | 113 ms | 1,813 ms |
| Per text at batch 24 | 25.8 ms | 28.6 ms | 1.8 ms | 1.8 ms | 29.1 ms |
| 24 texts of mixed length (1–4 sentences) | 1,697 ms | 1,700 ms | 95 ms | 86 ms | 1,833 ms |
| Same 24 texts again (cache hit) | 1.6 ms | 1.6 ms | 1.6 ms | 1.7 ms | 1.3 ms |
| 24 cached texts, new topic | 26 ms | 30 ms | 15 ms | 15 ms | 30 ms |
| WebAssembly linear memory | 221 MiB | 221 MiB | 102 MiB | 102 MiB | 219 MiB |
| 2,000-post page: long tasks / blocking time | 0 / 0 ms | 0 / 0 ms | 0 / 0 ms | 0 / 0 ms | 0 / 0 ms |
| 2,000-post page: first blur / settled | 796 / 1,162 ms | 844 / 1,208 ms | 826 / 982 ms | 968 / 1,211 ms | 855 / 1,167 ms |

The Chrome-stable CPU run reports `only a software (fallback) WebGPU adapter`
as the reason for using the CPU, which is what users with blocklisted GPUs
see in Settings → Advanced → Diagnostics.

## Other models (f16, CPU, Chromium)

| Metric | MiniLM-L6 | MiniLM-L3 | bert-tiny |
|---|---|---|---|
| Weights | 42.8 MiB | 32.6 MiB | 8.2 MiB |
| Cold start / worker init | 391 / 192 ms | 513 / 278 ms | 173 / 101 ms |
| Warm, 24 texts | 619 ms | 386 ms | 54 ms |
| Per text at batch 24 | 25.8 ms | 16.1 ms | 2.3 ms |
| WebAssembly linear memory | 221 MiB | 191 MiB | 58 MiB |

## Observations

* **The page's main thread is not blocked.** In every configuration the
  2,000-post page shows no long task (> 50 ms): scanning and DOM updates are
  incremental and inference runs in the offscreen worker.
* **WebGPU is ~14× faster per text** than the WASM CPU backend (25.8 vs
  1.8 ms), with a slower cold start (shader compilation; p95 of small batches
  includes first-time compilation for new shapes). Run-to-run GPU variance is
  large on this laptop: earlier sessions with identical engine code measured
  1.5–2.6 ms per text.
* **f16 vs f32:** worker initialisation 192 vs 361 ms and half the download;
  inference speed is unchanged (computation is f32). WebAssembly memory drops
  by 43 MiB on the WebGPU path (145 → 102 MiB, previous session) but not on
  the CPU path; see `docs/MODEL.md#performance-trade-offs`.
* **Margin scoring costs nothing measurable**: background embeddings ship
  precomputed; per text it adds 26 dot products of 384 values.
* **The cache makes topic changes cheap**: switching topics re-embeds only
  the topic, not the page.

## Optimisations and their measured effect

| Change | Before | After |
|---|---|---|
| WebAssembly SIMD (`+simd128`) | 95 ms/text (batch 24: 2,269 ms) | 32 ms/text (batch 24: 765 ms) |
| Length-sorted chunks of 8 on CPU (was 32, unsorted) | mixed-length 24: 2,523 ms; batch 64: 2,007 ms | 1,608 ms; 1,679 ms |
| First request after configuration limited to 8 texts | first blur 1,645 ms (cold) | 873 ms; all visible done at 1,443 ms |
| f16 weight storage | 85.5 MiB weights, worker init 361 ms | 42.8 MiB, 192 ms |
| Shared engine in the offscreen document (vs per-tab worker) | one model load per tab (and, in the original design, semantic inference never started) | one load for all tabs |
| Embedding cache (LRU, 4,000 entries) | — | identical texts ≈ 1–2 ms; topic switch 15–30 ms for 24 texts |

The first three rows were measured on MiniLM-L6 with f32 weights during
development (intermediate runs were not kept as JSON; numbers are from the
benchmark output at the time).

Not adopted: WebAssembly threads (needs cross-origin isolation of the
offscreen document and a rayon port of the backend — large complexity for a
CPU fallback), int8 quantisation (not supported by the backend's kernels
without custom work; f16 already halves the download), `wasm-opt` (binaryen
is not part of the toolchain; the 11 MiB engine is small next to the
weights).

## Image filtering

`node scripts/benchmark-vision.ts` (raw: `docs/benchmarks/vision-*.json`):
real extension, SigLIP base/16 int8 on the WebAssembly CPU backend, topic
"cats", default strictness, gallery of 40 distinct photos from the
development image set (no cache hits), same machine as above, headless
Chromium. Paired runs, same day, same workload: the build at `5743a93`
(one WebAssembly thread) and the current build.

| Metric | 1 thread (`5743a93`) | 4 threads (Task 06) |
|---|---|---|
| Image model threads (16 logical cores) | 1 | 4 |
| Image model load (worker: fetch + session) | 460 ms | 476 ms |
| Turning images on → first picture hidden (cold) | 1,856 ms | 1,854 ms |
| Per new picture, inference (mean of 40) | 564 ms | **166 ms** |
| Per new picture, wall time on a 40-photo page | 580 ms | **167 ms** |
| Same page again (cached embeddings), all 40 | 359 ms | 358 ms |
| Memory, all browser processes (PSS): peak over text-only (sampled every 250 ms) | +896 MiB | +952 MiB |
| Memory 25 s later (text encoder released), over text-only | +352 MiB | +361 MiB |
| Text filtering of a long page: alone / while the gallery is analysed | 131 / 138 ms | 137 / 154 ms |

**Multi-threaded inference.** The extension pages are cross-origin isolated
(`cross_origin_embedder_policy: require-corp`, `cross_origin_opener_policy:
same-origin` in the manifest), which gives the offscreen document's workers
`SharedArrayBuffer`, and the image worker uses ONNX Runtime's non-bundled
build, whose WebAssembly threads start from a separate file
(`offscreen/vision/ort-wasm-simd-threaded.mjs`). Threads = half the logical
cores, at most 4 (`src/offscreen/offscreen.ts`); results are bit-identical
for any thread count (`tests/e2e/vision.test.ts`). Thread sweep in the
image worker (16 dev photos, median): 1 → 630 ms, 2 → 317 ms, 4 → 184 ms,
8 → 207 ms. An earlier attempt (Task 05) failed because it ran the
*bundled* build on the page's main thread; the bundled build starts its
threads from its own script. Isolation does not affect anything else the
extension pages load (all extension-owned); image downloads are CORS-mode
requests, unaffected by COEP (end-to-end and privacy tests pass).

**What a user sees while scrolling** (`scripts/benchmark-scroll.ts`, raw:
`docs/benchmarks/vision-scroll-chromium.json`): a feed of 64 distinct
photos (16 cats) scrolled at constant speed, topic "cats". 9 of the 16 cat
photos are recognised at rest (the others are recall misses, not latency);
for those 9:

| Scroll speed | Build | Blurred before appearing | Shown unblurred the whole time on screen | Exposure median |
|---|---|---|---|---|
| 1,000 px/s (≈ 3 photos/s) | 1 thread | 1 | 8 | 942 ms |
| 1,000 px/s | 4 threads | **9** | **0** | **0 ms** |
| 2,000 px/s (≈ 6 photos/s) | 1 thread | 1 | 8 | 468 ms |
| 2,000 px/s | 4 threads | 1 | 6 | 468 ms |

No other photo was blurred in any run. At 2,000 px/s the feed shows more
photos per second than one CPU pipeline analyses (~5–6/s); a longer
look-ahead (1.5 viewports) only changed 6 → 5 and would analyse — and, with
downloads on, download — more pictures the user may never reach, so the
look-ahead stays at half a viewport. Single picture at rest, inserted →
blurred: median 681 → 201 ms.

**Memory, corrected method.** Earlier tables reported "peak" as a single
reading at the end of the gallery. With the 1-thread build that reading came
after the short-lived text encoder had already been released (the gallery
took ~25 s), which made the peak look like +473 MiB; sampled every 250 ms,
the real peak with both encoders loaded is ~+900 MiB in both builds. The
steady cost (image encoder only) is unchanged at ~+360 MiB.

Rejected: the 4-bit export of the image encoder (`vision_model_q4.onnx`,
same pinned repository): 63 vs 99 MB and ~42 % less worker memory, but
2.0× slower with 4 threads (367 vs 184 ms) and 2.3× on one thread, with
measurably different outputs (would need a new independent evaluation). The
uint8 export is the same size with no speed or memory gain; ONNX Runtime
session options (no pre-packing, no memory arena, "extended" optimisation)
changed memory by < 6 % and speed not at all.

Optimisations of Task 05 (same benchmark, 1 thread):

| Change | Before | After |
|---|---|---|
| Background prompt embeddings computed at build time instead of on the first picture (22 text-encoder runs ≈ 3.7 s) | first picture 6.4 s | 2.4 s |
| Text encoder in its own worker, terminated 20 s after its last use (WebAssembly memory is only returned when a worker ends) | encoder memory permanent | released 20 s after the last new topic |
| Image encoder unloaded after 5 minutes without an image request (Task 06; measured with a 10 s test build, extension process PSS) | 1,077 MiB while active, permanent | 349 MiB after unload (text-only 303 MiB); next picture 0.86 s |

Not done: WebGPU (no WebGPU kernels for the int8 operators; fp16 files would
double the package). Pictures stay visible until analysed.
