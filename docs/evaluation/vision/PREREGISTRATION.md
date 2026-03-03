# Image filtering — pre-registered evaluation (Task 05)

Written and committed **before** the held-out validation images were scored.
Everything below is frozen for that single validation run; the results go to
`RESULTS.md` whatever they are.

## Model choice (development spike)

Two candidates were run in headless Chromium with ONNX Runtime Web (WebAssembly
CPU, 1 thread), on the development images only, with identical preprocessing
code:

| candidate | licence | int8 size (image + text) | median image latency | dev mAP (raw cosine, 10 topics) | best dev F0.5 (topic vs. generic background) |
|---|---|---|---|---|---|
| OpenAI CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32`) | MIT; model card calls deployed use out of scope | 89 + 65 MB | 155 ms | 0.897 | 0.80 (recall 0.61; "cars" 0/15) |
| **Google SigLIP base/16-224 (`Xenova/siglip-base-patch16-224`)** | Apache-2.0 | 99 + 111 MB | 575 ms | 0.954 | 0.91 (recall 0.83) |

Rejected without a spike: MobileCLIP-S0 (Apple research licence, not
redistributable in a product), SigLIP/CLIP fp16 or larger variants (size).
Multi-threaded WebAssembly (needs cross-origin isolation) crashed the renderer
in the bundled configuration and was dropped; inference is single-threaded.

**Chosen: SigLIP base/16-224, int8.** Quality and licence outweigh the 4×
latency; the latency is handled by viewport-first scheduling, caching and
explicit limits (docs/ARCHITECTURE.md).

## Data

* Openly licensed Wikimedia Commons photos (CC0, public domain, CC BY, CC BY-SA),
  400–500 px thumbnails. The public manifest (`manifest.json`) lists title,
  page, licence, author, label and sha256 for every image; the image files
  themselves stay outside the repository.
* Labels were assigned by looking at every image (contact sheets) before any
  model was run on it. Duplicates, text-only graphics (word marks), collages,
  diagrams and mislabelled search hits were excluded. Images whose subject is
  genuinely unclear without context (a GPU mining rig, a hardware wallet, a
  price chart, an empty stadium, a dog-walking pictogram, a cat sculpture,
  aircraft engines, crowds that may or may not be a protest) are kept and
  marked **ambiguous**: they never count as positives or negatives and are
  reported separately.
* **dev** (245 images): the first collection. Used for the model choice, the
  prompt templates, the synonym cut-off and the thresholds.
* **val** (223 images): a second collection, gathered and labelled after dev
  with different search queries, excluding every dev image. It was not
  embedded or scored before this document was committed.

## Frozen decision rule (`src/shared/vision.ts`)

* Prompts per topic: "a photo of {topic}.", "a picture of {topic}.", "an image
  showing {topic}." (embeddings averaged).
* 22 generic background prompts (written once as a taxonomy of image genres,
  not tuned per topic); a background prompt is ignored for a topic when their
  text cosine is ≥ 0.92.
* Match ⇔ cos(image, topic) ≥ minSimilarity **and** cos(image, topic) −
  max cos(image, background) ≥ minMargin:

  | mode | minSimilarity | minMargin |
  |---|---|---|
  | precision (default) | 0.04 | 0.000 |
  | balanced | 0.04 | −0.005 |
  | aggressive | 0.03 | −0.015 |

## Evaluation protocol

* Topics: cats, dogs, football, rugby, basketball, cryptocurrency, cars,
  airplanes, politics, fast food. For each topic every non-ambiguous image of
  another label is a negative; neighbouring labels (rugby/basketball for
  football, gold/stocks for cryptocurrency, dogs for cats, portraits for
  politics, …) are also reported separately.
* `node scripts/evaluate-vision.ts --manifest <private>/manifest.json --set val`
  runs once, in Chromium, with the production worker and decision code.

## Acceptance targets (from the task brief)

For the default "precision" mode on val, pooled over the ten topics:

1. precision ≥ 0.80;
2. recall ≥ 0.60 (preferred);
3. false-positive rate ≤ 10 % on clearly unrelated images;
4. per-topic precision reported; topics below 0.80 are named as limitations
   rather than tuned on val.

If a target is missed, the feature still ships **off by default and labelled
experimental**, and the miss is reported, not re-tuned on val.
