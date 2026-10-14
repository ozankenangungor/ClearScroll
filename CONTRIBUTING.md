# Contributing

Thanks for helping. This file covers local setup, conventions and the review
workflow; release steps are in `docs/PRODUCTION_RUNBOOK.md`.

## Setup

```bash
npm ci
npx playwright install chromium
npm run setup:model      # one-time: .venv + verified model artifacts
npm run build
```

See the runbook for tool versions. `CLEARSCROLL_MODEL=bert-tiny` gives a
much smaller model for quick iteration (lower quality; thresholds differ).

## Layout

```
src/
  shared/      pure TypeScript shared by all contexts (unit-tested in Node)
  content/     content script: controller (state machine), dom helpers, css
  background/  service worker
  offscreen/   offscreen document + EngineHost (queue, cache, fail-over)
  engine/      dedicated worker around the WASM module
  options/ popup/ ui/   extension pages
  *.rs, bin/   Rust engine and the native CLI used by tooling
tools/         Python: model export, reference parity
scripts/       build, validate, evaluate, benchmark, privacy check, packaging
tests/         unit (Node), dom (Chromium), e2e (extension), parity.rs, fixtures
eval/          labelled evaluation dataset
docs/          architecture, model card, benchmarks, privacy, runbook, decisions
```

## Conventions

* **TypeScript:** `strict`, `noUncheckedIndexedAccess`, erasable syntax only
  (Node runs tests without a compiler), explicit `.ts` import extensions. No
  runtime dependencies; prefer small pure functions in `src/shared/`.
* **Untrusted input:** page text, stored settings and messages are untrusted.
  Validate at boundaries (`protocol.ts` guards, `normalizeSettings`), render
  with `textContent`, never `innerHTML` with dynamic data.
* **DOM changes:** only through `src/content/dom.ts` — extension-owned
  attributes, reversible, idempotent.
* **Rust:** `cargo fmt`, `cargo clippy -- -D warnings` for both the native
  and the wasm32 target. Errors are `Result`s with messages that tell the user
  what to do; no panics on bad input.
* **Numbers in docs** must come from a script in this repository. Do not
  edit generated files (`docs/evaluation/RESULTS.md`, `docs/benchmarks/*.json`,
  `THIRD_PARTY_NOTICES.md`) by hand.

## Tests

Every bug fix should come with a test that fails without the fix (the DOM
harness in `tests/dom/harness.ts` lets you script request timing; the fake
worker in `tests/unit/engine-host.test.ts` lets you script backend failures).

```bash
npm run check          # typecheck + unit + Rust
npm run test:dom
npm run build && npm run test:e2e && npm run verify:privacy
CLEARSCROLL_BROWSER=chrome npm run test:e2e   # also on Google Chrome stable
```

Changes to the model, tokenizer, pooling, scoring, background topics or
thresholds also require `tools/parity.py` (if numerics changed, both dtypes)
and `node scripts/evaluate-all.mjs`; `tests/unit/profiles.test.ts` fails
until the shipped thresholds equal the published calibration.

## Workflow

1. Branch from `main`; keep commits focused, with messages in the
   imperative mood (`fix(content): …`, `feat(engine): …`).
2. Make sure CI passes locally (`npm run check`, DOM/E2E tests).
3. Open a pull request describing the problem, the change and how it was
   verified (commands and results).
