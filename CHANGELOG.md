# Changelog

## 0.3.0 — unreleased (release candidate)

First version under the ClearScroll name (previously "IdeaBlocker").

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
