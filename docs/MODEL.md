# Model card

## Shipped model

| | |
|---|---|
| Model | [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) |
| Revision | `1110a243fdf4706b3f48f1d95db1a4f5529b4d41` (pinned) |
| Licence | Apache-2.0 (notice, modifications and licence text ship in the package) |
| Architecture | BERT encoder: 6 layers, hidden 384, 12 heads, FFN 1536, vocab 30,522 (uncased WordPiece), 22.4 M parameters |
| Pooling | attention-masked mean pooling + L2 normalisation (as sentence-transformers) |
| Max sequence | 128 tokens (position table truncated at export) |
| Weights file | 42.8 MiB, **IEEE-754 half precision (f16)**, decoded to f32 on load; sha256 `a32a3156…5c94a` (`tools/model_lock.json`) |
| Scoring | **margin**: similarity to the topic minus the best similarity to unrelated background topics (below) |

Alternatives that build from the same code and are fully calibrated:
`minilm-l3` (`sentence-transformers/paraphrase-MiniLM-L3-v2`, Apache-2.0)
and `bert-tiny` (`prajjwal1/bert-tiny`, MIT — the model of the original
prototype). Select with `CLEARSCROLL_MODEL=<id>`; `CLEARSCROLL_DTYPE=f32`
keeps full-precision weights. Both variables apply to `npm run setup:model`
and `npm run build`.

## Provenance and reproducibility

`tools/prepare_model.py` (driven by `npm run setup:model`):

1. downloads `config.json`, the checkpoint and `vocab.txt` at the pinned
   revision and checks each file's sha256 against `tools/model_lock.json`;
2. loads the encoder with `transformers` and **fails** if any encoder tensor
   is missing or has the wrong shape (the original `export_model.py` silently
   fell back to random weights);
3. checks the architecture (absolute positions, exact GELU) against the lock;
4. writes the CSWT file: a 44-byte header (magic, format version,
   dimensions, LayerNorm ε, dtype) followed by tensors in a fixed order,
   linear weights transposed to `[in, out]`; with `--dtype f16` values are
   rounded to binary16 and any overflow is an error;
5. verifies the parameter count and that the export's sha256 equals the value
   pinned **for that dtype** (exports are byte-for-byte deterministic);
6. writes `model.json` with metadata, self-test reference embeddings and the
   embeddings of the background topics — both computed by PyTorch **from
   the identically rounded weights**, so they describe exactly what ships.

Python dependencies are hash-locked (`tools/requirements.lock`, CPU-only
PyTorch). The Rust parser (`src/weights.rs`) re-validates the header and the
exact payload length and rejects NaN/Inf, so a truncated or foreign file is
an error, never a silently wrong model. The f16 decoder is checked against
NumPy for all 63,488 finite half values.

## Correctness against the reference

`tools/parity.py` compares the Rust implementation with Hugging Face
`tokenizers` (`BertWordPieceTokenizer`, cross-checked against
`AutoTokenizer` where the repo ships one) and `transformers` `BertModel` on 24
adversarial inputs (empty strings, Turkish, accents, CJK, emoji, control
characters, a 101-character word, >128 tokens):

| | Token-id mismatches | max \|Δ embedding\| | min cosine |
|---|---|---|---|
| bert-tiny (f32) | 0 / 24 | 1.2 × 10⁻⁷ | 0.99999988 |
| all-MiniLM-L6-v2 (f32) | 0 / 24 | 3.0 × 10⁻⁷ | 0.99999988 |
| all-MiniLM-L6-v2 (f16 vs PyTorch with the same rounding) | 0 / 24 | 2.5 × 10⁻⁷ | 0.99999982 |
| *original prototype tokenizer* | **10 / 24** | — | — |

The original tokenizer failed on all Turkish sentences with ç/ğ/ş/ü,
precomposed accents (no NFD before stripping marks), Greek/Cyrillic capitals,
CJK and words over 100 characters, and was rebuilt for every batch. The
original encoder used Burn's default LayerNorm ε = 1e-5 instead of BERT's
1e-12 (max |Δ| 1.6 × 10⁻⁴ — real but negligible).

**Effect of f16 storage** (f16 vs f32 Rust embeddings over all 389 dataset
texts and queries): max |Δ| 2.8 × 10⁻⁴, minimum cosine 0.999999, similarity
scores move by at most 3.6 × 10⁻⁴ (mean 6.9 × 10⁻⁵) — below the 0.005
calibration grid, so all calibrated thresholds are identical for f16 and f32.

Fixtures from `parity.py` are committed under `tests/fixtures/` and enforced
by `cargo test` (`tests/parity.rs`); CI requires the f16 and f32 parity tests.
On GPU, `tests/gpu_parity.rs` (manual, needs a GPU) measured max |Δ|
3.8 × 10⁻⁷ against PyTorch with native wgpu, stable across changing batch
shapes, and the in-browser WebGPU backend reproduced the CPU scores to
~1 × 10⁻⁷ on an NVIDIA Ampere GPU.

## Margin scoring against background topics

Short, generic page furniture ("Posted 3 hours ago · 12 comments", "Sign in
to continue reading this story") is mildly similar to *every* short topic
query, so with plain cosine similarity it crosses the threshold for many
topics. ClearScroll therefore compares each text with 26 fixed **background
topics** (`src/shared/background-topics.json`): 22 generic subjects (cooking,
travel, weather, music, pets, science, …) and 4 page-furniture classes
("website menu, login and account settings", "comments, likes and shares",
"advertisement", "article date, author and reading time"). The decision score
is

```
score = cos(text, topic) − max cos(text, b)   over background topics b with cos(topic, b) < 0.5
```

Background topics that are near-synonyms of the user's topic (cos ≥ 0.5,
e.g. "sports" for "football") are not used against it; a topic close to all
of them competes with the least similar one, so the score always stays on
the calibrated scale. The background list is generic and was not derived
from the evaluation topics. Its embeddings are precomputed into `model.json`
(no first-request cost).

bert-tiny is scored by raw cosine (`scoring: "raw"` in its profile): its
similarities are uniformly high (≈ 0.6–0.9 for any pair), so a margin carries
no information.

## Evaluation

Full generated report: [`docs/evaluation/RESULTS.md`](evaluation/RESULTS.md);
comparison variants in `docs/evaluation/variants/` (`node scripts/evaluate-all.mjs`).
Embeddings come from the shipped Rust code, decisions from the shipped
`decide()` function.

**Dataset v2** (`eval/dataset.jsonl`, `eval/topics.json`): 356 texts
(246 English, 110 Turkish) across 8 topics — cryptocurrency, movie/TV
spoilers, politics, sports, video games, technology, health/fitness and
finance — with neutral texts, 30 *hard negatives* built around lexical traps
("the crypt beneath the cathedral", "chicken stock"), 12 multi-label items,
"hard" positives without topic keywords ("Lost my seed phrase…") and — new in
v2 — **38 English UI strings** (navigation, article metadata, ads, cookie and
sign-in banners), labelled negative for every topic under a rule fixed before
running any model (*page furniture is not content about a topic, even when it
names a section*). 33 topic phrasings. Labels were assigned by the author
from the text content. **Limitations:** single annotator, synthetic
news/social-style sentences, small Turkish set, and the UI set was added
after UI false positives were observed (results are therefore reported with
and without it).

**Method.** Unit = (topic phrasing, text) pair in the same language; 50/50
split by a hash of the item id; thresholds chosen on the English calibration
half only, maximising F0.5 (precise), F1 (balanced) or F2 (thorough) for the
hybrid classifier; all numbers below are on the held-out English test half.

**Shipped configuration (MiniLM-L6, f16, margin scoring)**

| Mode | Threshold | Precision | Recall | F1 | FPR | FPR on UI strings |
|---|---|---|---|---|---|---|
| Precise | 0.055 | 75.2% | 44.6% | 56.0% | 1.4% | 1.8% |
| Balanced | 0.005 | 66.1% | 61.4% | **63.7%** | 3.0% | **1.8%** |
| Thorough | −0.04 | 44.6% | 76.1% | 56.2% | 9.1% | 5.0% |

**Margin vs raw cosine (MiniLM-L6, balanced, each calibrated separately)**

| | Raw cosine | Margin (shipped) |
|---|---|---|
| Test split incl. UI strings: F1 / FPR on UI strings | 54.2% / 17.6% | **63.7% / 1.8%** |
| Content texts only (same thresholds as above): F1 | 64.2% | 64.8% |
| v1 dataset (no UI strings, re-calibrated): F1 / ROC-AUC | **67.4% / 0.922** | 64.8% / 0.910 |
| Thorough mode, incl. UI strings: F1 / FPR on UI strings | 46.7% / 47.1% | 56.2% / 5.0% |

The trade-off is explicit: on clean content alone raw cosine is ~2.6 F1
points better, but on pages — which always contain navigation, metadata and
banners — it blurs one in six UI strings in balanced mode and almost half in
thorough mode. A robustness check during development with only the 22
generic background topics (no page-furniture classes) already reduced UI
false positives from 17.4% to 2.1%, so the effect does not depend on the
four classes written for page furniture.

**Model comparison (f16, English test split, balanced, shipped scoring)**

| Model | Scoring | Precision | Recall | F1 | FPR | UI FPR | ROC-AUC |
|---|---|---|---|---|---|---|---|
| all-MiniLM-L6-v2 | margin | 66.1% | 61.4% | **63.7%** | 3.0% | 1.8% | 0.914 |
| paraphrase-MiniLM-L3-v2 | margin | 58.4% | 52.7% | 55.4% | 3.6% | 2.1% | 0.897 |
| bert-tiny | raw | 23.9% | 55.4% | 33.4% | 17.0% | 29.4% | 0.730 |
| keywords only | — | 50.0% | 1.1% | 2.1% | 0.1% | — | — |

f32 weights give identical thresholds and, for MiniLM-L6 balanced, identical
metrics (`docs/evaluation/variants/f32-weights`).

**Legacy thresholds.** The prototype's 0.68 / 0.62 / 0.56 were never
calibrated: with bert-tiny they flagged about half of all unrelated text;
with MiniLM they match almost nothing (recall 1.1–1.6%). Thresholds are now
stored per model in `src/shared/models.ts`, and a unit test pins them to the
published calibration.

**Turkish.** ROC-AUC 0.52–0.56 for every model — close to chance; with the
English-calibrated balanced threshold MiniLM-L6 flags 63.5% of unrelated
Turkish pairs. All three encoders are English-only (English WordPiece
vocabulary), so ClearScroll documents English as the supported language;
keyword rules (accent-insensitive) still work in any language. A multilingual
encoder (e.g. paraphrase-multilingual-MiniLM-L12-v2) needs a SentencePiece
tokenizer and a 250k-token embedding table and was not adopted.

**Topic phrasing.** Prefixing topics with a template ("This text is about
{topic}.") lowered F1 for all three models and is not used. Concrete topics
work better than broad ones ("football" or "soccer" rather than "sports").

## Known failure modes

* **Mixed-subject texts can lose to a background topic** (cost of margin
  scoring): "Dogecoin spiked again after a celebrity posted a picture of a
  Shiba Inu" has cosine 0.264 to "cryptocurrency" but 0.288 to "pets and
  animals", so it is not blurred.
* **Domain knowledge is limited**: "Solana validators reported another
  outage…" is far from "cryptocurrency" and is missed.
* **Keyword fallback is literal**: it catches explicit mentions only (recall
  1–6%) and also matches navigation that names a topic ("Crypto · Markets ·
  Tech"); on real pages navigation regions are protected and not analysed.
* Texts shorter than 30 / 24 / 16 characters (precise / balanced / thorough)
  are never matched semantically (too little signal), only by keywords.

## Performance trade-offs

Measured in the extension on an i7-11800H (details: `docs/BENCHMARKS.md`):

| Model (f16) | Package | CPU ms/text (batch 24) | WebGPU ms/text | WASM memory, CPU / WebGPU | EN F1 |
|---|---|---|---|---|---|
| all-MiniLM-L6-v2 | 54.8 MiB | 25.8 | 1.8 (NVIDIA Ampere) | 221 / 102 MiB | 63.7% |
| paraphrase-MiniLM-L3-v2 | 44.6 MiB | 16.1 | not measured | 191 MiB / — | 55.4% |
| bert-tiny | 20.1 MiB | 2.3 | not measured | 58 MiB / — | 33.4% |

f16 halves the weights (85.5 → 42.8 MiB; package 97.5 → 54.8 MiB) and
roughly halves worker initialisation; inference speed is unchanged
(computation is f32). WebAssembly memory drops by 43 MiB on the WebGPU path
but not on the CPU path, although the native peak heap of the same Rust code
drops by 43 MiB (173.5 → 130.8 MiB) — the CPU-path footprint is set by the
WebAssembly allocator and is still under investigation.

## Updating the model

See `docs/PRODUCTION_RUNBOOK.md#model-update`. In short: add an entry to
`tools/model_lock.json`, run `prepare_model.py --model <id> --dtype f16
--update-lock` (and `--dtype f32`; maintainers only, trust-on-first-use),
regenerate parity fixtures with `tools/parity.py --write-fixtures` (both
dtypes), run `node scripts/evaluate-all.mjs`, copy the calibrated thresholds
into `MODEL_PROFILES` (the profile test fails until they match), and re-run
the full test and benchmark suites. Changing `background-topics.json`
requires the same steps.
