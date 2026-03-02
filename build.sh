#!/usr/bin/env bash
set -euo pipefail

DIST="dist"

echo "==> Cleaning $DIST/"
rm -rf "$DIST"
mkdir -p "$DIST/pkg"

echo "==> Compiling TypeScript → JavaScript (esbuild)"

# Content script — IIFE format (content scripts can't be ES modules in MV3)
npx esbuild src/extractor.ts \
  --bundle \
  --outfile="$DIST/extractor.js" \
  --format=iife \
  --target=es2022 \
  --minify

# Worker — ESM format (loaded as { type: 'module' })
npx esbuild src/brain.worker.ts \
  --bundle \
  --outfile="$DIST/brain.worker.js" \
  --format=esm \
  --target=es2022 \
  --minify

echo "==> Copying manifest.json"
cp manifest.json "$DIST/"

echo "==> Copying WASM pkg/"
cp pkg/text_classifier_wasm.js "$DIST/pkg/"
cp pkg/text_classifier_wasm_bg.wasm "$DIST/pkg/"

echo "==> Build complete. Load '$DIST/' as an unpacked extension in Chrome."
echo "    Files:"
ls -lh "$DIST/"
ls -lh "$DIST/pkg/"
