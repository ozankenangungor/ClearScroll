# Engineering decisions

Each entry: the problem as found, the decision, the alternatives, and how it
is verified. "Measured" means reproduced in this repository with the scripts
named; nothing here is estimated.

## 1. Run inference in an offscreen document, not in a page-created worker

**Found.** A real-Chromium probe of the original build (load extension, set a
topic, open a page) showed:

* `new Worker(chrome-extension://…/brain.worker.js)` from the content script →
  `SecurityError: cannot be accessed from origin 'http://127.0.0.1:…'`;
* the blob-worker fallback then failed with `Failed to fetch dynamically
  imported module: …/pkg/text_classifier_wasm.js` (`use_dynamic_url` vs. the
  static extension id) → the worker logged *"Falling back to lexical-only
  mode"* on every page;
* on a page with `worker-src 'self'` the blob worker was blocked and **no
  filtering happened at all**.

So the semantic engine, the core feature, had never executed in a browser.

**Decision.** An offscreen document (extension origin, extension CSP) owns a
dedicated worker; content scripts send texts through the background service
worker.

**Alternatives.** Fixing the blob path (still subject to every site's CSP —
`wasm-unsafe-eval`, `worker-src`); running in the service worker (no
dedicated workers, killed after ~30 s idle, so the 85 MiB model would reload
constantly); a sandboxed iframe injected into pages (page-visible,
fingerprintable, CSP `frame-src` issues).

**Costs.** One extra hop of extension messaging (sub-millisecond compared to
inference), `offscreen` permission (no install warning), Chrome ≥ 116.
**Benefits.** Works under strict CSPs; one model in memory for all tabs; no
`web_accessible_resources`.

**Verified by** E2E: *"works on pages with a strict Content-Security-Policy"*,
*"several tabs share a single engine instance"*.

## 2. Replace bert-tiny with all-MiniLM-L6-v2

**Found.** `scripts/evaluate.ts` on the 318 labelled texts of dataset v1: mean-pooled
bert-tiny gives cosine 0.689 for related vs 0.644 for unrelated pairs
(English ROC-AUC 0.766). At the shipped 0.62 threshold it flagged 54 % of
unrelated content.

**Decision.** Ship sentence-transformers' all-MiniLM-L6-v2 (trained for
sentence similarity, same BERT architecture and vocabulary → **no new
inference code**, only new weights and thresholds). English test-split F1 at
balanced: 40.0 % → 67.5 %, FPR 14.3 % → 4.4 %.

**Alternatives.** MiniLM-L3 (half the compute, F1 58.6 %) is available as a
build option; a multilingual model was rejected for size (SentencePiece +
250k vocabulary). See `docs/MODEL.md`.

**Costs.** Package 28 → 97 MiB (55 MiB after f16 storage, §12); CPU latency
1.7 → 28 ms per text; WASM memory 51 → 219 MiB. Mitigated by WebGPU (2.6 ms/text), caching and near-viewport
scheduling.

## 3. Thresholds are calibrated per model, never guessed

The original 0.68/0.62/0.56 thresholds were hypotheses. They are now chosen
on a calibration split (F0.5/F1/F2 per mode) and stored per model in
`src/shared/models.ts`; unknown models refuse to run semantically instead of
borrowing another model's thresholds (unit test *"unknown model ids are not
silently given someone else's thresholds"*). CI runs the evaluation and fails
if English F1 drops below 60 %.

## 4. Immutable configuration snapshots instead of SET_TARGET/SET_CONFIG

**Found.** The old worker mutated global `referenceEmbedding`, `mode` and
token lists from separate messages and processed requests concurrently
(`void processRequest(req)`); an `await embed_text()` in `SET_TARGET` let a
`COMPARE` run against the old embedding with the new mode. Replies were
applied to elements without checking whether the configuration or the
element's text had changed.

**Decision.** Every classify request carries `{generation, mode, topics}`;
the engine host is stateless with respect to configuration (it only caches
embeddings, keyed by text). The content script applies a verdict only if the
generation is current, filtering is still active, the element is connected
and its text is unchanged.

**Alternatives.** A serialised queue around the old stateful protocol would
fix interleaving but not stale replies arriving after a change; a state
machine in the worker adds complexity without removing the need for the
content-side checks.

**Verified by** DOM tests *"a reply computed for old settings is
discarded…"*, *"disabling filtering while a request is in flight never
re-blurs…"*, *"text that changes while its request is in flight…"*,
*"out-of-order replies are applied to the right elements"*; unit tests
*"queued requests from an older generation… are dropped"* and *"replies
always carry the generation and topics of their own request"*. Mutation
check: removing the generation or text comparison makes the corresponding
tests fail.

## 5. Verify numerics at run time (self-test + GPU canary)

**Found.** In headless Chromium the only WebGPU adapter is SwiftShader
(software). The engine initialised there "successfully" and then returned NaN
embeddings — and in another run correct self-test results followed by
identical vectors for every text. A status of "semantic engine active
(WebGPU)" would have been false. Native wgpu on the real GPUs of the same
machine matched PyTorch (max |Δ| 3.8 × 10⁻⁷, also across changing batch
shapes), so the kernels are correct and the emulator is not.

**Decision.** (1) Skip software adapters (`isFallbackAdapter`); the WASM CPU
path is faster than an emulated GPU anyway. (2) After loading, embed two
reference sentences and compare with PyTorch's vectors stored in
`model.json`. (3) On the GPU, append one reference sentence (the canary) to
every batch and reject the batch if it deviates. Any failure fails over to
the CPU backend and the status detail says why.

**Verified by** unit tests (*canary*, *self-test*, *runtime failure*,
*hung initialisation*) and an E2E test that forces the SwiftShader adapter
and checks that CPU takes over with correct results.

## 6. Serialise browser-API lifecycles

**Found** while benchmarking: on a cold start, two concurrent requests both
saw "no offscreen document" and both called `createDocument` (*"Only a single
offscreen document may be created"*), or one closed the other's half-loaded
document (*"Offscreen document closed before fully loading"*). The affected
units were then never retried, because IntersectionObserver does not fire
again for elements already on screen — only 8 of ~50 visible paragraphs were
ever classified.

**Decision.** One lock for all offscreen operations; one promise chain for
content-script registration; failed requests re-queue their units with
exponential backoff (0.5 s → 30 s).

**Verified by** E2E *"cold start with concurrent tabs: every on-screen unit is
analysed (regression)"* — it fails 3/3 with the lock disabled — and DOM tests
for retries.

## 7. Reversible, attribute-based visuals

The old code wrote `style.filter`/`style.transition` and cleared them with
`""`, destroying any inline filter the page had set. Now the only visible
change is the `data-clearscroll` attribute styled by an injected stylesheet;
`tabindex`/`title` are added only when absent and removed again. A DOM test
asserts the element's `outerHTML` is byte-identical after `stop()`.

Limitation: while blurred, our `filter` overrides the page's own `filter` on
that element (CSS cannot compose filters); it is restored on unblur.

## 8. Units, not text nodes

Text nodes inside one paragraph (`<p>Bit<b>coin</b> news</p>`) used to be
classified separately, each blurring the shared parent with possibly
conflicting verdicts. Text is now attributed to the nearest non-inline
ancestor; elements with block children are containers and are never blurred
whole. This also stops a short snippet from blurring a large container.

## 9. Near-viewport scheduling and a small first batch

Classifying a whole long page wastes compute. IntersectionObserver (±1.5
viewports) decides what to queue; hidden tabs use layout geometry because
IntersectionObserver does not run without rendering (found when background
tabs were never filtered). The first request after (re)configuration carries
8 texts: measured first blur on a cold engine 1,645 → 873 ms.

## 10. Rust engine: runtime weights, strict parsing, HF-exact tokenizer

* Weights are loaded at run time from a validated file instead of
  `include_bytes!` (CI could not even `cargo check` because the gitignored
  `model/weights.bin` was missing — the cause of every recorded CI failure,
  exit code 101).
* The tokenizer mirrors Hugging Face `BertNormalizer`/`BertPreTokenizer`/
  `WordPiece` (NFD accent stripping, Unicode punctuation categories, CJK
  splitting, 100-character word limit) — 0/24 mismatches vs. 10/24 before.
* Exact (erf) GELU and the model's LayerNorm ε from the weight header.
* Length-sorted chunks (8 on CPU, 32 on GPU) and WASM SIMD: CPU per-text
  latency 95 → 28 ms.

## 11. Site rules: one definition everywhere

The old content-script matcher treated `example.com` as exact while the
generated `excludeMatches` also covered subdomains, and arbitrary wildcards
like `*foo*.com` produced invalid Chrome match patterns that made
`registerContentScripts` fail (silently, so filtering stopped everywhere).
Now inputs are normalised (IDNA, ports, paths), invalid ones are rejected in
the UI, and a unit test checks that the content-script matcher and Chrome's
pattern semantics agree.

## 12. Half-precision weight storage

**Decision.** Store weights as IEEE-754 binary16 and decode to f32 on load.
**Measured.** Package 97.5 → 54.8 MiB, worker initialisation 361 → 192 ms;
Rust f16 vs PyTorch with identical rounding max |Δ| 2.5 × 10⁻⁷; f16 vs f32
similarity shift ≤ 3.6 × 10⁻⁴, identical calibrated thresholds, balanced F1
unchanged on the shipped configuration. Inference speed is unchanged.
WebAssembly memory fell by 43 MiB on the WebGPU path but not on the CPU path
even though the native peak heap fell by 43 MiB — an allocator-level effect
left documented rather than claimed as a saving.
**Alternatives.** int8: needs custom kernels and a separate quality study;
f16 compute: requires the `shader-f16` GPU feature and does not exist on the
CPU backend. **Verified by** an exhaustive decoder test (all 63,488 finite
half values vs NumPy) and a required f16 parity test in CI.

## 13. Margin scoring against background topics

**Found.** Adding 38 UI strings to the evaluation set showed raw cosine
similarity blurring 27.6 % of (UI string, topic) pairs at the shipped
balanced threshold: generic page furniture is mildly similar to every short
query. **Decision.** Score = similarity to the topic − best similarity to 26
fixed, unrelated background topics (22 subjects + 4 page-furniture
classes); near-synonyms of the topic (cos ≥ 0.5) are excluded, and a topic
close to all of them competes with the least similar one, so the score never
silently changes scale. Background vectors ship precomputed in `model.json`.
**Measured (MiniLM-L6, balanced, held-out English):** F1 54.2 → 63.7 % and
UI false positives 17.6 → 1.8 % with UI strings; on the v1 content-only set
F1 67.4 → 64.8 % — an accepted, documented trade-off. A generic-only variant
reduced UI false positives to 2.1 %, so the gain does not rest on the four
page-furniture classes. bert-tiny keeps raw cosine (its similarities are
uniform). **Alternatives.** Raising thresholds (costs recall everywhere),
DOM heuristics for metadata (site-specific, unmeasurable on this dataset),
a learned classifier head (needs labelled training data we do not have).
**Verified by** unit tests for the margin, near-synonym and generic-topic
cases, CI gates on F1 and UI false positives, and a test pinning the
shipped thresholds to the published calibration.

## 14. Keyboard focus survives reveal and unblur

An axe-core audit and keyboard tests found that revealing an item with Enter
removed the `tabindex` we had added, so Chrome moved focus to `<body>` and
the user lost their place. The added tabindex is now changed in place to
`-1` on reveal, restored to `0` if the item is blurred again, and removed
only after focus has left the element. Options page, popup and blurred
elements have 0 WCAG 2.1 A/AA violations (light and dark).

## 15. Privacy check: control for the browser, not just "no extension"

The first network-capture check compared a ClearScroll session with a
shorter session without any extension. On Google Chrome stable it reported
`android.clients.google.com/checkin` as caused by ClearScroll. A control
with a no-op extension reproduced the same request at the same times
(≈ 5 s and ≈ 26 s after start) — Chrome's GCM check-in, timer-driven. The
check now uses a no-op extension as control and equal 45-second sessions; a
planted telemetry `fetch` is still detected by both criteria.

## 16. Testing on branded Google Chrome

Branded Chrome ignores `--load-extension` since version 137; the test helper
loads the extension through the DevTools `Extensions.loadUnpacked` command.
All end-to-end and accessibility tests pass on Chrome 153 stable, and CI
runs them there too.

## 17. Independent reviews

Two code-review passes and a security review were run over the branch.
They found, among others: units wedged after detachment from the DOM,
keyword verdicts after transient messaging errors becoming permanent, an
orphaned content script's cleanup erasing the new instance's state, silent
loss of legacy site rules during migration, registration status lost on
service-worker restarts, a permanent keyword-only state after one timeout,
an unbounded per-frame map, a topic-template `$` escaping bug, a margin /
raw-cosine scale mismatch for very generic topics, and CI gaps (cache key,
f32 parity no longer required, a quality gate that passed with no data).
Each was reproduced by a failing test first and fixed. The security review
found no exploitable issue.

## 18. Image filtering as a second, isolated engine

* **A different model family, not the text encoder.** MiniLM embeds text
  only; comparing it with image embeddings would be meaningless. SigLIP has
  an image and a text encoder trained into one space, so arbitrary topics
  can be compared with pictures zero-shot. The Rust engine was not touched.
* **ONNX Runtime Web, not Transformers.js.** Prebuilt int8 ONNX files exist
  for the chosen model; ORT's WebAssembly bundle is one 73 KB module plus a
  14 MB `.wasm`, with no remote loading. The tokenizer (SentencePiece
  Unigram) and preprocessing are ~200 lines of verified TypeScript; pulling
  Transformers.js would have added its Node-only dependencies to the
  toolchain for no runtime benefit.
* **Same offscreen document, separate workers and host.** One loaded model
  for all tabs; a failure or slow picture never delays or degrades text.
  The text encoder runs in its own short-lived worker (terminated when idle)
  because WebAssembly memory is returned only when a worker ends — measured
  steady-state cost dropped from +592 MiB to +359 MiB; background prompt
  embeddings are computed at build time (cold start 6.4 s → 2.4 s).
* **Pixels from the page, downloads only by explicit choice.** Reading the
  displayed picture through a canvas needs no request and works for
  same-origin, CORS and `data:`/`blob:` pictures. Cross-origin pictures taint
  the canvas; rather than screenshots or debugger access, the user can allow
  one cookie-less download per such picture, restricted to public hosts.
  This keeps "no network requests" exactly true for every other setting and
  is verified by the network-capture test.
* **Precision first.** A picture must look more like the topic than like any
  of 22 generic descriptions *and* reach a similarity floor; thresholds were
  calibrated on development photos only and the validation photos scored
  once after pre-registration. Uncertain pictures stay visible.
* **Multi-threaded inference (Task 06).** The extension pages are made
  cross-origin isolated (COOP/COEP in the manifest) so the model workers get
  `SharedArrayBuffer`; ONNX Runtime's non-bundled build starts its threads
  from its own glue file. 564 → 166 ms per picture with 4 threads, identical
  outputs. The Task 05 attempt had failed for a specific reason: the bundled
  build, run on a page's main thread, starts its threads from its own script.
* **Not done:** WebGPU (no WebGPU kernels for the int8 operators; fp16 files
  would double the size), video frames, iframes and shadow roots.

## Things deliberately not done

* **Optional host permissions / per-site activation.** Would make the product
  require a permission prompt per site and complicate registration; host
  access remains required and is documented. A reasonable next step.
* **Shadow DOM and iframe support.** Requires per-root observers and
  stylesheet injection; documented as a limitation.
* **WASM threads, quantisation.** See `docs/BENCHMARKS.md`.
