# IdeaBlocker

Local-first Chrome MV3 extension that blurs semantically related text using a Rust/WASM model running in a worker.

## Core Principles

1. Zero cloud processing (all inference in-browser).
2. No UI thread ML execution.
3. Precision-first filtering with user controls.

## Architecture

1. `src/background.ts`: Dynamic content-script registration based on saved settings.
2. `src/extractor.ts`: DOM extraction + batching + visual blur (`requestAnimationFrame`).
3. `src/brain.worker.ts`: Semantic + lexical decision engine in worker thread.
4. `src/lib.rs` + `src/state.rs`: Rust/WASM embedder runtime (Burn/WebGPU).
5. `src/options.ts` + `options.html`: User controls (target, mode, exclusions, protected selectors).
6. `src/settings.ts`: Shared settings schema and normalization.

## Modes

1. `precision`: Lowest false positives.
2. `balanced`: Mid-point tradeoff.
3. `aggressive`: Higher recall, more risk of false positives.

## Local Development

```bash
npm ci
npm run typecheck
cargo check --target wasm32-unknown-unknown --release
bash build.sh
```

Load `dist/` from `chrome://extensions` -> `Load unpacked`.

## Production Notes

1. Content script is dynamically registered only when target is non-empty.
2. Site exclusions are applied centrally in background script.
3. Worker gracefully falls back to lexical-only mode if semantic engine fails.
4. Release process checklist lives in `docs/PRODUCTION_RUNBOOK.md`.
