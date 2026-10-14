# ClearScroll — project summary

**What it is.** A Chrome extension that hides web content about topics the
user chooses ("cryptocurrency", "movie spoilers"), using a sentence-embedding
model that runs locally in the browser. Rust + WebAssembly (Burn, WebGPU or
CPU), TypeScript, Manifest V3, Web Workers.

**Problem.** Keyword blockers miss most related content ("Lost my seed phrase…"
never says *crypto*) and cloud classifiers would send everything a person
reads to a server. Local semantic similarity addresses both — if it actually
works in the browser and actually separates topics.

**Why these technologies.**
* *Local inference* keeps page text on the device; there is nothing to
  secure on a server because there is no server.
* *Rust/WASM* gives one numerically verified implementation of the encoder
  that runs natively (tests, evaluation, parity) and in the browser, with a
  WebGPU backend for speed and a SIMD CPU backend as a portable fallback.
* *An offscreen document + Web Worker* keeps inference off every page's main
  thread, outside page CSPs, and shared across tabs.

**Engineering challenges and how they were resolved.**
1. *The core feature had never run.* A real-browser probe showed the original
   worker could not start from a content script and silently fell back to
   keywords (or did nothing under strict CSPs). Re-architected around an
   offscreen document.
2. *The model was not good enough.* Built a 318-text labelled dataset and an
   evaluation harness that runs the shipped code. bert-tiny reached F1 40 %
   with a 14 % false-positive rate; all-MiniLM-L6-v2 reaches 67.5 % / 4.4 %
   (English, held-out split). Thresholds are calibrated per model; Turkish
   was measured, found to be at chance level and documented as unsupported.
   Adding UI strings to the dataset exposed that plain cosine similarity
   blurs page furniture; scoring against background topics cut those false
   positives from 17.6 % to 1.8 % (F1 63.7 % on the expanded set).
3. *Numerical correctness.* Reimplemented the tokenizer to match Hugging Face
   exactly (the old one disagreed on 10/24 inputs) and verified embeddings to
   3 × 10⁻⁷. Found that Chrome's software WebGPU adapter returns NaN or stale
   buffers; added a start-up self-test and a per-batch GPU canary that fall
   back to CPU.
4. *Concurrency.* Replaced a mutable worker state with immutable per-request
   configuration snapshots and generation checks; found and fixed two
   offscreen-document lifecycle races and a starvation bug through
   benchmarking, each with a regression test that fails without the fix.
5. *Performance.* WASM SIMD and length-sorted batching cut CPU inference from
   95 to 26–29 ms per text; WebGPU on an RTX 3050 Mobile runs at ~2 ms per
   text; half-precision weights halved the package (97 → 55 MiB); a
   2,000-post page shows no main-thread long tasks.

**Validation.** 59 unit tests, 26 DOM-integration tests in Chromium with a
scripted classifier (out-of-order replies, settings changes mid-flight),
25 end-to-end and axe-core accessibility tests of the packaged extension —
passing on Chromium and on Google Chrome stable — Rust parity tests against
PyTorch fixtures (f32 and f16), a controlled network-capture privacy test,
CI quality gates, two independent code reviews and a security review.

**Lessons.**
* "It compiles" and "the status says active" are not evidence; a five-minute
  real-browser probe found the most important bug of the project.
* Measure the model before tuning thresholds: the old thresholds were
  meaningless for the new model and dangerous for the old one.
* Benchmarks double as integration tests — two races and a starvation bug
  showed up as numbers that did not add up.
* A test that cannot fail is worse than none: a parity gate that skipped
  silently, an async predicate that resolved instantly, a quality gate that
  passed with no data and a privacy check without a proper control were all
  caught by deliberately breaking things.
