# ClearScroll

**Hide posts and articles about topics you choose — using an AI model that
runs entirely in your browser.**

ClearScroll is a Chrome extension that blurs web content semantically related
to topics such as "cryptocurrency", "movie spoilers" or "election news". A
sentence-embedding model written in Rust and compiled to WebAssembly runs in
a background worker on your machine (on the GPU via WebGPU when available);
page text is never sent anywhere.

![Before and after: crypto and football items blurred on a news page](docs/images/3-filtered.png)

> **Status:** release candidate `0.3.0`, buildable and tested locally and in
> CI. Not published on the Chrome Web Store. English only (see
> [limitations](#limitations)).

## Features

* **Semantic topics** — in balanced mode "football" also catches "Messi
  scores twice in the final", which never mentions the word; several topics
  can be active at once and toggled individually.
* **Three strictness levels** with thresholds calibrated on a labelled
  dataset (not guessed).
* **Reveal on click or Enter** for any single item; filtering continues.
* **Per-site control** from the toolbar popup; site rules with validation.
* **Honest status** — shows whether the semantic engine runs on WebGPU or
  CPU, or whether only keyword matching is available, and why.
* **Private by construction** — no server, no telemetry; verified by an
  automated network-capture test.

| Settings | Popup | Revealed item |
|---|---|---|
| ![Options page](docs/images/2-options.png) | ![Popup](docs/images/5-popup.png) | ![Revealed](docs/images/4-revealed.png) |

## How it works

```mermaid
flowchart LR
  CS["Content script<br/>finds paragraphs near the viewport"] -- texts + config snapshot --> BG["Service worker<br/>routing"]
  BG --> OFF["Offscreen document<br/>queue · cache · decisions"]
  OFF --> W["Web Worker<br/>Rust → WebAssembly<br/>MiniLM encoder (WebGPU / CPU)"]
  W -- embeddings --> OFF -- verdicts --> CS
```

1. The content script groups page text into paragraph-sized **units** and
   sends the ones near the viewport, in small batches, together with an
   immutable snapshot of the current settings.
2. In an offscreen document, the engine embeds texts and topics with
   [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
   (mean pooling, L2 norm) and compares them by cosine similarity against a
   per-model, per-mode threshold; keyword rules complement it.
3. The content script applies a verdict only if the settings, the element
   and its text are still the same, by toggling an extension-owned attribute
   styled with `filter: blur()` — page markup and styles are left untouched.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
design rationale: [docs/ENGINEERING_DECISIONS.md](docs/ENGINEERING_DECISIONS.md)

## Results

**Quality** — English, held-out test split of 318 labelled texts, balanced
mode ([full report](docs/evaluation/RESULTS.md), [method](docs/MODEL.md#evaluation)):

| Classifier | Precision | Recall | F1 | False-positive rate |
|---|---|---|---|---|
| ClearScroll (MiniLM-L6 + keywords) | 65.2 % | 70.1 % | 67.5 % | 4.4 % |
| Keywords only | 100 % | 1.1 % | 2.2 % | 0.0 % |
| Previous model (bert-tiny), calibrated | 31.3 % | 55.4 % | 40.0 % | 14.3 % |

The Rust engine reproduces the Hugging Face reference implementation:
0/24 token-id mismatches, max embedding difference 3 × 10⁻⁷.

**Performance** — Chromium 156, i7-11800H ([details](docs/BENCHMARKS.md)):

| | WebGPU (NVIDIA Ampere) | CPU (WASM SIMD) |
|---|---|---|
| 24 texts | 62 ms | 666 ms |
| Engine cold start | 0.9 s | 0.5 s |
| Main-thread long tasks on a 2,000-post page | 0 | 0 |
| WebAssembly memory | 145 MiB | 219 MiB |

## Install (from source)

Requirements: Node.js ≥ 22.18, Rust via [rustup](https://rustup.rs) (the
pinned toolchain installs automatically), Python 3.13 (or [uv](https://docs.astral.sh/uv/)),
and `wasm-bindgen-cli` matching `Cargo.lock`:

```bash
git clone https://github.com/ozankenangungor/ClearScroll.git && cd ClearScroll
cargo install wasm-bindgen-cli --version 0.2.129 --locked
npm ci
npm run setup:model   # pinned model download + export + sha256 verification
npm run build         # → dist/
npm run validate
```

Then open `chrome://extensions`, enable *Developer mode*, choose *Load
unpacked* and select `dist/`. Open the extension's settings, add a topic and
browse. Chrome 116 or newer is required.

## Testing

```bash
npm run check                     # typecheck, 47 unit tests, Rust tests
npx playwright install chromium
npm run test:dom                  # 20 content-script tests in real Chromium
npm run test:e2e                  # 15 end-to-end tests of the built extension
npm run verify:privacy            # network capture: no requests from the extension
npm run evaluate                  # semantic quality report
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs all of the
above plus formatting, Clippy for native and wasm32, dependency licence and
advisory checks, model-artifact verification, Rust/PyTorch parity and a
quality gate (English F1 ≥ 60 %).

## Privacy and security

* All processing is local; settings are stored in `chrome.storage.local`.
* Permissions: host access to http/https pages, `scripting`, `storage`,
  `offscreen` — each justified in [docs/PRIVACY.md](docs/PRIVACY.md).
* No `web_accessible_resources`, no remote code, CSP
  `script-src 'self' 'wasm-unsafe-eval'`; all messages are validated.
* The model ships inside the package; there are no run-time downloads.

## Limitations

* **English only.** All bundled encoders use an English vocabulary; on
  Turkish text ranking quality is at chance level (ROC-AUC ≈ 0.53).
  Keyword rules still work in any language.
* **Imperfect recall and precision.** About 30 % of related English texts are
  missed at balanced strictness, and some short UI strings are blurred
  wrongly (e.g. "Home & Garden · 3 min read" for the topic "football"). Broad
  topics ("sports") work worse than concrete ones ("football").
* Text inside **shadow DOM** and **iframes** is not analysed.
* Content is visible briefly until it is classified (≈ 0.1 s warm; up to
  ~1 s on the first page after the engine starts).
* The package is large (~97 MiB, mostly model weights); a lighter MiniLM-L3
  build is available (`CLEARSCROLL_MODEL=minilm-l3`).

## Troubleshooting

| Problem | Fix |
|---|---|
| Status says "Keyword matching only" | Settings → Advanced → Diagnostics shows the reason; try *Inference engine: CPU only*. |
| Nothing is blurred | Check that filtering is enabled and a topic is active; reload tabs opened before installing. |
| Part of a site breaks | Add the area to *Protected areas* (CSS selector) or exclude the site from the popup. |
| Build: `wasm-bindgen CLI … requires …` | Install the exact version printed. |
| Build: sha256 mismatch | `rm -rf build/models && npm run setup:model`. |

More in [docs/PRODUCTION_RUNBOOK.md](docs/PRODUCTION_RUNBOOK.md).

## Project structure

```
src/shared/      settings, site rules, protocol, classifier, model profiles
src/content/     content script (controller, DOM helpers, CSS)
src/background/  service worker
src/offscreen/   offscreen document, engine host (queue, cache, fail-over)
src/engine/      Web Worker around the WASM module
src/*.rs         Rust engine: weights, tokenizer, BERT encoder, WASM bindings
tools/           model export and reference parity (Python)
scripts/         build, validation, evaluation, benchmarks, privacy check
tests/           unit, DOM, end-to-end, Rust parity, fixtures
eval/            labelled evaluation dataset
docs/            architecture, model card, benchmarks, privacy, runbook
```

## Roadmap

* Optional host permissions / per-site activation.
* Quantised (f16/int8) weights to cut package size and memory, gated on parity
  and evaluation.
* Shadow DOM and same-origin iframe support.
* A multilingual model, and UI-string negatives in the evaluation set.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports with a page that
reproduces the issue are very welcome.

## License and attribution

ClearScroll is licensed under the [ISC License](LICENSE). It bundles the
weights of `sentence-transformers/all-MiniLM-L6-v2` (Apache-2.0) and
compiles Rust crates under permissive licences; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
