# Changelog

## 0.3.0 — unreleased (release candidate)

First version under the ClearScroll name (previously "IdeaBlocker").

### Added
- **Image filtering (opt-in, experimental).** An on-device image–text model
  (SigLIP base/16, int8 ONNX, ONNX Runtime Web on the WebAssembly CPU
  backend) analyses the pixels of pictures near the viewport and blurs those
  that show an active topic, without needing captions, alt text or nearby
  text. Supports `<img>`/`<picture>`, video posters and CSS background
  pictures; icons, avatars, SVG and protected areas are skipped. Click or
  Enter reveals a picture; text- and image-hidden content never nests.
  Held-out evaluation (223 photos, 10 topics, default strictness): precision
  0.93, recall 0.80, false-positive rate 0.4 %; football vs rugby and
  politics are named weaknesses (`docs/evaluation/vision/RESULTS.md`).
- Optional *Also check pictures from other domains*: downloads a copy of
  displayed cross-origin pictures without cookies or referrer (public hosts
  only, size/type/time limits). Off by default; with it off ClearScroll still
  makes no network requests at all.
- Image-model status and counters in the popup and options diagnostics.
- Image downloads never follow redirects (a redirect target is never
  requested) and are aborted immediately when download permission or image
  filtering is withdrawn; requests approved just before such a change are
  refused (review fix, Task 05.1). An image request authorised just before
  image filtering was turned off can no longer load the image model again
  or recreate a closed offscreen document when it is delivered late
  (review fix, Task 05.2).
- Faster image analysis (Task 06): the extension pages are cross-origin
  isolated, so the image model runs on up to 4 WebAssembly threads
  (0.56 → 0.17 s per picture on an 8-core laptop; results identical for any
  thread count). While scrolling at ~3 photos/s, matching photos are now
  blurred before they appear.
- Topic embeddings for pictures are kept in the extension's IndexedDB, so
  turning images back on, a restart or many topics no longer rerun the text
  encoder (first picture 1.9 → 0.85 s).
- The image model is unloaded after 5 minutes without pictures.
- The popup says how many pictures were checked, hidden and still pending.
- **Fewer wrong text matches on neighbouring subjects (Task 07).** A text
  is no longer hidden when it is clearly about a sibling of the topic —
  rugby or basketball for "football", dogs for "cats", gold or stocks for
  "cryptocurrency", trailers for "movie spoilers" (sibling veto,
  `src/shared/siblings.ts`). Pre-registered held-out evaluation, 22 new
  pages, 7 topics (3 never used in development), balanced: precision
  44.2 → 81.1 %, recall 83.4 → 82.1 %, false-positive rate 28.7 → 5.2 %;
  hidden cards 33.0 → 6.6 % false positives. Keyword matches and topics
  outside the six covered domains are unchanged.
- *Thorough* now filters pictures like *Balanced*: its looser picture rule
  mostly hid the wrong photos (held-out: 27 → 9 false positives).
- Image privacy checks (`npm run verify:privacy:images`), real-model browser
  tests, PyTorch parity fixtures, an image benchmark and a pre-registered
  image evaluation.

### Fixed
- The semantic engine never ran in the browser: content scripts cannot start
  extension workers and the blob fallback could not load the WASM module or
  was blocked by page CSPs. Inference now runs in an offscreen document.
- CI could not build from a clean checkout (`include_bytes!` of a gitignored
  weights file). Weights are prepared by a pinned, verified pipeline and
  loaded at run time.
- Tokenizer differed from the reference on 10 of 24 test inputs (accents,
  Turkish, CJK, long words); now identical. LayerNorm ε corrected.
- Worker processed configuration changes and comparisons concurrently; stale
  results could be applied after settings changed or text changed.
- Page inline `filter`/`transition` styles were overwritten.
- Invalid wildcard site rules broke content-script registration everywhere;
  content-side and Chrome-side exclusion semantics disagreed.
- Race conditions when several tabs started the engine at once; failed
  requests were never retried.
- Background tabs were never filtered (IntersectionObserver does not run
  without rendering).

### Changed
- Example topics in the options page and README no longer suggest "movie
  spoilers": topics are matched by what a text is about, and spoilers are
  not detected as such (measured on real pages).
- Real-world evaluation texts are kept private; a manifest with checksums,
  counts and source pages is published instead.
- The first request after a page loads or settings change is sent without
  waiting for the page to stop changing: matching content is visible for
  ~0.2–0.7 s instead of ~0.5–1.1 s on live pages with the engine running.
- A match hides the whole feed item (video card, news promo) including its
  thumbnail and metadata, not only the matching text; text without such an
  item is hidden on its own as before.
- Model: `sentence-transformers/all-MiniLM-L6-v2` replaces bert-tiny
  (English F1 40.0 % → 67.5 %, false positives 14.3 % → 4.4 % at balanced).
- Thresholds calibrated per model on a labelled dataset.
- Text is grouped into paragraph-level units; only near-viewport units are
  classified.
- WASM SIMD and length-sorted batching: CPU inference 95 → 28 ms per text.
- `web_accessible_resources` removed; `offscreen` permission added; minimum
  Chrome 116.

### Added
- Real-world evaluation set (eval/realworld: 3,152 hand-labelled text units
  from live pages, dev/test split) and `scripts/evaluate-realworld.ts`;
  live-site tools `scripts/live-capture.ts` and `scripts/live-latency.ts`.
- Margin scoring against 26 background topics: false positives on UI strings
  (navigation, metadata, ads) 17.6 % → 1.8 % in balanced mode; evaluation
  set v2 with 38 UI strings; CI gate on UI false positives.
- Half-precision weight storage (default): package 97.5 → 54.8 MiB, worker
  initialisation ~2× faster, identical calibrated thresholds.
- Full licence texts of all compiled crates in the package.
- axe-core accessibility suite (0 WCAG 2.1 A/AA violations); focus is kept
  on revealed and cleared items.
- Tests and privacy check on Google Chrome stable.
- Notice on the options page for IdeaBlocker site rules that could not be
  migrated.
- Multiple topics (enable/disable/edit), global pause, engine preference.
- Click/keyboard reveal of individual items.
- Toolbar popup with per-page status and "never run on this site".
- Honest engine status (WebGPU / CPU / keyword fallback, with reasons).
- Startup self-test and per-batch GPU canary against PyTorch reference values.
- Settings migration from IdeaBlocker.
- Unit, DOM-integration, end-to-end, parity and privacy tests; evaluation and
  benchmark harnesses; documentation.
