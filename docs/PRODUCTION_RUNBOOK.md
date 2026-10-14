# Production runbook

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22.18 (CI: 24) | runs TypeScript scripts/tests natively (type stripping) |
| Rust | 1.97.0 via rustup | pinned in `rust-toolchain.toml` (incl. `wasm32-unknown-unknown`, rustfmt, clippy) |
| wasm-bindgen CLI | must equal the `wasm-bindgen` version in `Cargo.lock` (0.2.129) | `cargo install wasm-bindgen-cli --version 0.2.129 --locked` |
| Python | 3.13 (the only version tested) | model export only; `uv` is used if present |
| zip | any | packaging only |
| Disk / network | ~1.5 GB for `.venv` + Hugging Face cache, ~90 MB model download | first build only |

## Build

```bash
npm ci
npm run setup:model    # creates .venv (hash-locked), downloads + exports + verifies the model
npm run build          # Rust → WASM, wasm-bindgen, TypeScript bundles, dist/
npm run validate       # deterministic checks on dist/
```

`CLEARSCROLL_MODEL=minilm-l3|bert-tiny` selects another calibrated model and
`CLEARSCROLL_DTYPE=f32` full-precision weights (default `f16`) for both
`setup:model` and `build`. `node scripts/build.mjs --dev` adds
inline source maps and skips minification (do not ship it; `validate`
rejects source maps).

## Test commands

| Command | What it covers | Needs |
|---|---|---|
| `npm run typecheck` | strict TypeScript over src, scripts, tests | — |
| `npm test` | unit tests: settings, site rules, protocol, lexical, classifier, engine host (concurrency, fail-over) | — |
| `npm run test:rust` | Rust unit + parity tests (parity skips without artifacts) | — |
| `CLEARSCROLL_REQUIRE_MODEL=minilm-l6-f16,minilm-l6 npm run test:rust` | same, parity **required** (f16 and f32) | f16 and f32 artifacts |
| `npm run test:dom` | content-script controller in real Chromium (races, reveal, mutations) | Playwright Chromium |
| `npm run test:e2e` | built extension end-to-end + axe-core accessibility | `build` |
| `CLEARSCROLL_BROWSER=chrome npm run test:e2e` | the same on Google Chrome stable (loaded via DevTools `Extensions.loadUnpacked`) | Chrome; `CHROME_PATH` if not `/usr/bin/google-chrome-stable` |
| `node scripts/verify-no-egress.ts --browser chrome` | privacy check on Chrome stable | Chrome |
| `node scripts/evaluate-all.mjs` | regenerate `docs/evaluation` and its variants | f16 + f32 artifacts of all three models |
| `npm run verify:privacy` | no network requests caused by the extension | `build` |
| `npm run evaluate` | semantic quality report (`--min-en-f1 0.6` as a gate) | `setup:model` |
| `npm run benchmark` | performance (see `docs/BENCHMARKS.md`) | `build` |
| `cargo test --release --no-default-features --features webgpu,cpu --test gpu_parity -- --ignored` | optional native GPU parity | a GPU |
| `cargo deny check` | Rust licences/advisories | cargo-deny |

Install Playwright's browser once: `npx playwright install chromium`
(CI: `--with-deps`).

## Verification checklist (before every release)

- [ ] `git status` clean; version bumped in `package.json` (manifest version is taken from it)
- [ ] `npm run release:prepare` passes (check → build → validate → DOM → E2E → privacy → package)
- [ ] `CLEARSCROLL_REQUIRE_MODEL=minilm-l6-f16,minilm-l6 npm run test:rust` passes
- [ ] `node scripts/evaluate.ts --models minilm-l6 --min-en-f1 0.60 --max-ui-fpr 0.05` passes; diff `docs/evaluation/RESULTS.md`
- [ ] `CLEARSCROLL_BROWSER=chrome npm run test:e2e` passes on Google Chrome stable
- [ ] `cargo deny check` and `npm audit --audit-level=high` clean
- [ ] Manual smoke test in **Google Chrome stable** (below), ideally on Windows/macOS too
- [ ] `docs/PRIVACY.md` still matches behaviour (permissions, storage, network)
- [ ] `THIRD_PARTY_NOTICES.md` regenerated if dependencies changed (`node scripts/third-party.mjs`)
- [ ] `CHANGELOG.md` updated

## Manual browser smoke test

1. `chrome://extensions` → Developer mode → *Load unpacked* → `dist/`.
   No errors on the card; the service worker is "active".
2. Toolbar → ClearScroll → *Settings…*. Add the topic `cryptocurrency`,
   choose *Balanced*, save. The status pill shows *Loading model…* and then
   *Semantic engine active (WebGPU)* or *(CPU)* once a page is opened.
3. Open a news site with crypto coverage: related headlines blur, unrelated
   ones do not, the page stays responsive, nothing in navigation or forms
   blurs.
4. Click a blurred item → it is revealed; links inside are not followed on
   that first click. Tab to a blurred item and press Enter → revealed.
5. Popup → *Never run on this site* → blur disappears in that tab; *Run on
   this site again* → blur returns without reload.
6. Untick *Filtering enabled* → all blur disappears; Settings → Advanced →
   Diagnostics shows the content script as not registered.
7. Settings → Advanced → Inference engine → *Keyword matching only* → status
   shows *Keyword matching only…*.
8. `chrome://extensions` → *Errors* is empty; the offscreen document's console
   (inspect "offscreen.html" from the extension card) shows the engine state.

## Packaging

```bash
npm run release:prepare      # ends with node scripts/package.mjs
ls release/                  # clearscroll-<version>.zip and .zip.sha256
```

The zip contains `dist/` only (no source maps, no tests). Nothing is
uploaded or published by any script.

## Release checklist (Chrome Web Store — manual, requires the owner)

- [ ] Developer account and listing owned by the project owner
- [ ] Upload `release/clearscroll-<version>.zip`
- [ ] Single-purpose description: "Hides web content about topics you choose, on-device"
- [ ] Permission justifications: copy from `docs/PRIVACY.md#permissions-and-why-they-are-needed`
- [ ] Data-usage form: no data collected or transmitted
- [ ] Privacy policy URL: link to `docs/PRIVACY.md` on GitHub
- [ ] Screenshots: `npm run screenshots` (real captures of the build)
- [ ] Package size: ~55 MiB (f16 model weights) — check the current Web Store size limit; MiniLM-L3 45 MiB, bert-tiny 20 MiB
- [ ] After approval: tag the release in git and attach the zip + checksum

ClearScroll is **not published** on the Chrome Web Store at the time of
writing.

## Failure recovery

| Symptom | Likely cause | Action |
|---|---|---|
| `weights.bin sha256 does not match the lock file` | stale or corrupt artifact | `rm -rf build/models/<model> && npm run setup:model` |
| `sha256 mismatch for pytorch_model.bin` during setup | upstream file changed or corrupt download | do **not** `--update-lock`; investigate upstream; retry download |
| `wasm-bindgen CLI … Cargo.lock requires …` | CLI version mismatch | install the version printed by the error |
| Status *Keyword matching only* unexpectedly | no backend initialised | Settings → Advanced → Diagnostics → *Detail*; try *CPU only* |
| Status detail `GPU canary mismatch` / `self-test failed` | broken GPU driver or emulator | expected fallback to CPU; report driver/OS/Chrome version |
| Nothing is blurred anywhere | content script not registered | Diagnostics → *Registration error*; reload the extension |
| A site is broken by blurring | over-broad match | add the region to *Protected areas*, or exclude the site |
| CI `browser` job fails only on CI | timing | re-run once; if reproducible locally with `npm run test:e2e`, treat as a bug |

## Model update

1. Add the model to `tools/model_lock.json` with empty hashes and its config.
2. `.venv/bin/python tools/prepare_model.py --model <id> --dtype f16 --update-lock`
   and the same with `--dtype f32` (trust-on-first-use: verify the Hugging
   Face revision manually first).
3. Run both exports again without `--update-lock`; they must reproduce the
   pinned sha256 values.
4. `cargo build --release --no-default-features --features cli && .venv/bin/python tools/parity.py --model <id> --write-fixtures`
   and the same with `--dtype f16` — both must print `PARITY OK`; commit the fixtures.
5. Add a profile to `MODEL_PROFILES` (`scoring: "margin"` unless its
   similarities are uniform, see docs/MODEL.md), run
   `node scripts/evaluate-all.mjs`, copy the calibrated thresholds into the
   profile (the profile unit test fails until they match) and commit
   `docs/evaluation/`. Editing `src/shared/background-topics.json` requires
   steps 2–5 as well, because `model.json` embeds the background vectors.
6. Rebuild, run the full checklist and benchmarks; update `docs/MODEL.md`,
   `THIRD_PARTY_NOTICES.md` and the licence notice if the licence differs.
