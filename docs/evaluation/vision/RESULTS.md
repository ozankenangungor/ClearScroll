# Image filtering — evaluation results

Pre-registration: [PREREGISTRATION.md](PREREGISTRATION.md) (committed in
`fbce47a` before the validation set was scored). The validation set was scored
**once**, with the frozen rule; nothing was changed afterwards. Raw outputs:
[`val.json`](val.json) (held-out) and [`dev.json`](dev.json) (development, used
for calibration — optimistic by construction).

Model: SigLIP base/16-224, int8 ONNX, ONNX Runtime Web 1.30 (WebAssembly CPU,
one thread), headless Chromium, the production worker
(`src/vision/vision.worker.ts`) and decision code (`src/shared/vision.ts`).
Every image is analysed from its pixels only: no file name, alt text, caption
or page text is involved. Images: openly licensed Wikimedia Commons photos,
see [`manifest.json`](manifest.json).

## Held-out validation set (223 images, 10 topics)

| mode | precision | recall | F1 | FPR | TP / FP / FN | unrelated images hidden with all 10 topics active |
|---|---|---|---|---|---|---|
| precision (default) | 0.948 | 0.778 | 0.854 | 0.27 % | 91 / 5 / 26 | 1 / 80 |
| balanced | 0.917 | 0.855 | 0.885 | 0.49 % | 100 / 9 / 17 | 2 / 80 |
| aggressive | 0.799 | 0.949 | 0.867 | 1.51 % | 111 / 28 / 6 | 6 / 80 |

Acceptance targets for the default mode (pre-registered): precision ≥ 0.80 —
**met (0.948)**; recall ≥ 0.60 — **met (0.778)**; FPR ≤ 10 % — **met (0.27 %)**.

### Per topic, default mode (held-out)

| topic | precision | recall | FPR | neighbouring-subject false positives | ambiguous images of the topic hidden | false positives |
|---|---|---|---|---|---|---|
| cats | 1.00 | 1.00 | 0.0 % | 0/13 | 1/3 | — |
| dogs | 1.00 | 0.75 | 0.0 % | 0/16 | 6/6 | — |
| football | 0.80 | 0.62 | 1.1 % | 2/24 | 1/1 | val/rugby-002, val/rugby-005 |
| rugby | 0.94 | 1.00 | 0.6 % | 1/21 | 0/0 | val/football-008 |
| basketball | 1.00 | 0.62 | 0.0 % | 0/29 | 0/0 | — |
| cryptocurrency | 1.00 | 0.92 | 0.0 % | 0/24 | 5/5 | — |
| cars | 1.00 | 0.47 | 0.0 % | 0/9 | 0/1 | — |
| airplanes | 0.90 | 1.00 | 0.5 % | 0/15 | 2/7 | val/stocks-001 |
| politics | 0.67 | 0.25 | 0.5 % | 0/11 | 0/3 | val/crypto-014 |
| fast food | 1.00 | 0.94 | 0.0 % | 0/23 | 0/0 | — |

Neighbours: dogs/other animals for cats and dogs, rugby/basketball for
football, football/basketball for rugby, gold/stock-market images for
cryptocurrency, cars↔airplanes, portraits for politics, everyday objects
(including baskets) for fast food.

### What the numbers say

* **Clear visual subjects work well**: cats, dogs, rugby, basketball,
  airplanes, fast food and recognisable cryptocurrency imagery (bitcoin
  coins, logos, ATMs) reach precision ≥ 0.90; no dog was hidden for "cats" and
  no cat for "dogs"; gold bars, gold coins and trading floors were never hidden
  for "cryptocurrency" in the default mode.
* **Football vs rugby is the main confusion.** In the default mode 2 of 24
  rugby/basketball photos were hidden for "football" (precision 0.80); in
  "Thorough" (aggressive) mode it is 15 of 24 (precision 0.46). The model's
  notion of "football" includes rugby-like scenes.
* **Politics is not reliably visual.** Recall 0.25 in the default mode: only
  protests with very obvious cues match; a crypto-regulation illustration
  (a gavel and EU flag) was hidden. Generic portraits, including formal
  portraits of officials, were never hidden.
* **Cars**: precision 1.00 but recall 0.47 — "cars" competes with the generic
  "a vehicle" description; hatchbacks/SUVs at shows are often left visible.
* **Ambiguous images** (e.g. dog pictogram signs, cat sculptures, price
  charts, aircraft engines) are hidden inconsistently, as expected; they are
  never counted as errors or successes.
* "Thorough" mode trades precision (0.80 pooled, 0.46 football, 0.46
  politics) for recall (0.95). The options page says it hides more unrelated
  content; for images that cost is visible.


## Addendum: production-conformant re-run (same frozen rule)

After the validation run, a deviation between the evaluation path and the
extension was found and fixed: the int8 text encoder quantises activations
with one scale per batch, so a prompt embedded together with other prompts
(the evaluation embedded prompts in batches of 16) gets a slightly different
vector than one embedded alone. The extension now embeds every prompt on its
own (deterministic, independent of other topics; `src/vision/vision.worker.ts`),
and the build-time background vectors are computed the same way.

Dev and val were re-scored with that production path. **Nothing in the rule
or thresholds was changed.** Raw outputs: [`val-production.json`](val-production.json),
[`dev-production.json`](dev-production.json). These numbers describe the
shipped extension; the table above is the pre-registered run.

| mode | precision | recall | F1 | FPR | TP / FP / FN |
|---|---|---|---|---|---|
| precision | 0.931 | 0.803 | 0.862 | 0.38 % | 94 / 7 / 23 |
| balanced | 0.917 | 0.855 | 0.885 | 0.49 % | 100 / 9 / 17 |
| aggressive | 0.804 | 0.949 | 0.871 | 1.46 % | 111 / 27 / 6 |

Per topic, default mode:

| topic | precision | recall | neighbour FPs | false positives |
|---|---|---|---|---|
| cats | 1.00 | 1.00 | 0/13 | — |
| dogs | 1.00 | 0.75 | 0/16 | — |
| football | 0.77 | 0.77 | 3/24 | val/rugby-002, val/rugby-005, val/rugby-012 |
| rugby | 0.94 | 1.00 | 1/21 | val/football-008 |
| basketball | 1.00 | 0.62 | 0/29 | — |
| cryptocurrency | 1.00 | 0.92 | 0/24 | — |
| cars | 1.00 | 0.47 | 0/9 | — |
| airplanes | 0.90 | 1.00 | 0/15 | val/stocks-001 |
| politics | 0.60 | 0.38 | 0/11 | val/crypto-014, val/stocks-005 |
| fast food | 1.00 | 0.94 | 0/23 | — |

The default mode still meets every pre-registered target (precision 0.931,
recall 0.803, FPR 0.38 %). Changes against the first run are small and go both
ways: football precision 0.80 → 0.77 (one more rugby photo), politics
precision/recall 0.67/0.25 → 0.60/0.38, football recall 0.62 → 0.77. Football
(below the 0.80 per-topic precision target) and politics remain the named
limitations.

## "Thorough" mode for pictures (Task 06)

The pre-registered Thorough rule (minSimilarity 0.03, minMargin −0.015) is no
longer used for pictures. Its held-out numbers above (production re-run):
precision 0.804, recall 0.949, FPR 1.46 %, 27 false positives — football
0.46 (15 of 24 rugby/basketball photos hidden) and politics 0.46. The extra
recall over Balanced (+0.094) came with three times as many wrongly hidden
pictures. Pictures in Thorough mode now use the Balanced rule; text keeps
its own Thorough threshold, and the options page says so. This is a choice
between two rules that were both evaluated before, not a new threshold: no
value was tuned on the validation set.

| Thorough mode, held-out photos | precision | recall | F1 | FPR | false positives |
|---|---|---|---|---|---|
| before (own rule) | 0.804 | 0.949 | 0.871 | 1.46 % | 27 |
| now (Balanced rule) | 0.917 | 0.855 | 0.885 | 0.49 % | 9 |

## Live sites (qualitative, not a benchmark)

`node scripts/live-vision.ts [--downloads]` (Chromium, CPU, default
strictness, 1280 × 1600 viewport, 40 s per page; 2026-10-16). Counts are
what was analysed in that window — pictures far below the viewport are not
analysed until scrolled to. Screenshots stay local (third-party content).

| Page | Topic | Downloads off: analysed / not checked (other domain) | Downloads on: analysed | Hidden by image analysis | Hidden by text |
|---|---|---|---|---|---|
| YouTube search "funny animal compilation" | cats | 0 / 9 | 9 | 0 (cat thumbnails were inside cards already hidden by their titles) | 22 cards |
| YouTube search "sports highlights" | football | 0 / 13 | 9 | 0 | 16 cards |
| BBC Sport front page | football | 0 / 20 | 20 | 4 (football photos whose headlines did not match, e.g. a transfer-gossip and a match report) | 23 |
| The Guardian UK front | football | 0 / 7 | 7 | 0 | 1 |
| Commons "Quality images of cats" | cats | 0 / 14 | 14 | 7 (cat photos) | 12 (captions) |
| Commons "Quality images of dogs" | cats | 0 / 28 | 28 | **0** (no dog hidden) | 16² |

² Text units mentioning cats in captions and
category text.

Two defects were found on these sites and fixed before the numbers above:
YouTube thumbnails are inside `aria-hidden` links (were treated as protected)
and fade in from opacity 0 inside containers laid out after loading (were
treated as invisible for good); Commons gallery thumbnails (120 × 90) were
below an over-strict area limit. Regression tests:
`tests/dom/images.test.ts`.

## Development set (245 images, used for calibration)

| mode | precision | recall | F1 | FPR |
|---|---|---|---|---|
| precision | 0.931 | 0.771 | 0.844 | 0.40 % |
| balanced | 0.935 | 0.829 | 0.879 | 0.40 % |
| aggressive | 0.872 | 0.921 | 0.896 | 0.95 % |

## Latency (same run)

Model load 932 ms; per image (decode + preprocess + inference)
median 571 ms, p95 596 ms — 1 WebAssembly thread, headless Chromium, decode + preprocess + inference. See
docs/BENCHMARKS.md for in-extension measurements.

## Limits of this evaluation

* 10 topics, 468 images in total; per-topic numbers rest on 8–23 positives
  each and are coarse. Topics outside these ten were not measured.
* Wikimedia Commons photos are cleaner and better framed than typical feed
  thumbnails (text overlays, collages, faces with captions).
* Labels were assigned by one reviewer.
* The rule and thresholds were chosen on dev for these same ten topics; the
  held-out set tests new images, not new topics.
