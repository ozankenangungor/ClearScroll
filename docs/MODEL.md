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

## Real-world evaluation

The synthetic set above is written to be clean; this one is what the
extension actually meets: 5,135 text units in three splits (dev, test,
held-out; two more were added in Task 07, see [Sibling veto](#sibling-veto-task-07)) captured with the built extension in Google Chrome from public
pages (BBC, The Guardian, Sky Sports, The Independent, CoinDesk, Hacker
News, YouTube search results; `scripts/live-capture.ts`), each labelled by hand for one
topic — "cryptocurrency", "football" or "movie spoilers" — following
`eval/realworld/GUIDELINES.md`, written before labelling and applied to the
text alone without seeing verdicts. Reddit, X and AP News block automated
browsers and are not included. The texts are third-party excerpts and are
kept private; `eval/realworld/MANIFEST.json` publishes each split's sha256,
counts and source pages, and the evaluator refuses data that does not match
it ([eval/realworld/README.md](../eval/realworld/README.md)).

Protocol: the **dev** split (pages captured first) was used for all error
analysis; the **test** split (different pages and sites, captured later,
labelled before it was evaluated) only for reporting. Any classifier change
had to pass a decision rule written down before the test split was
captured. Report: [docs/evaluation/realworld/RESULTS.md](evaluation/realworld/RESULTS.md)
(`node scripts/evaluate-realworld.ts --errors 8 --out …`).

Task 03 numbers (the test split has since been inspected and is no longer
treated as blind; see the next section for the current held-out split):

| Balanced, English, as shipped | Precision | Recall | F1 | FPR |
|---|---|---|---|---|
| test — cryptocurrency | 58.2 % | 76.5 % | 66.1 % | 18.1 % |
| test — football | 53.7 % | 77.9 % | 63.6 % | 50.4 % |
| test — movie spoilers | 48.6 % | 93.4 % | 63.9 % | 51.4 % |
| **test — all** | **53.2 %** | **81.2 %** | **64.3 %** | 37.2 % |
| dev — all | 64.2 % | 78.6 % | 70.7 % | 17.0 % |

The offline evaluator was checked against the live extension: of 1,794 dev
units, every unit the extension blurred is also predicted positive offline;
the 145 differences are units the extension had not analysed yet when the
capture ended.

Where the errors come from:

* **Neighbouring subjects (most false positives; model limit).** The test
  pages were chosen to contain them, and that is where precision collapses:
  rugby texts score 0.16–0.23 against "football" (threshold 0.005), gold
  and inflation texts 0.12–0.16 against "cryptocurrency", and NBA, rugby
  league and sports-UI strings do the same on the dev pages. There is no
  threshold that separates them without losing most true matches.
* **"Spoilers" is a property of a text, not a subject.** Embeddings encode
  what a text is about, so "movie spoilers" matches film content in general:
  trailers score 0.19–0.28 and the highest-scoring false positives are
  reviews that say they are spoiler-free ("No spoiler review…", 0.39–0.42).
* **Short texts (largest group of false negatives).** 35 of 93 dev misses are
  shorter than the 24-character minimum for semantic matching in balanced
  mode — channel names and labels such as "Premier League" or "Crypto
  World" — and match by keywords only.
* **Text extraction is not a measurable source.** Visually hidden text is
  included (BBC appends "Video, 00:05:04" and repeats the headline), and 11
  of the 31 dev texts with it are misclassified; scoring the visible
  headline alone gives 11 errors too (one fixed, one broken). They fail
  for their content — headlines that only name clubs and people.

**Tried and rejected: a stricter semantic threshold for short texts.** Rule
(fixed in advance): the highest-recall value in {0.30, 0.25, 0.20, 0.15}
whose added dev matches are ≥ 90 % correct. Measured with the exact
classifier (an earlier hand count that ignored keyword matches overstated
the gain), the added matches were 6/7, 11/13, 20/31 and 26/43 correct — no
value qualified, the gain is at most +2.5 points of recall, and the misses
it adds are visible page labels ("BBC Sport", "Basketball", "More sport").
Not shipped; the test split was not used for it.

**Whole-item hiding** (a match hides its card, see ARCHITECTURE.md) does not
change these per-text numbers, but it changes what they mean on screen: a
correct match now also hides the item's thumbnail, and a false positive
hides a whole card instead of one line.

## Reducing false positives (Task 04)

**Root cause.** Margin scoring compares a text with the user's topic and with
26 generic background topics (cooking, travel, music …). None of them is a
neighbour of the subjects users ask for, and background topics with cosine
≥ 0.5 to the user's topic are dropped as near-synonyms, so for "football"
nothing competes on behalf of rugby or basketball, and for "cryptocurrency"
nothing on behalf of gold, stocks or inflation. Re-tuning the threshold
alone barely helps (dev F1 70.7 → 71.8 %).

**Candidates measured on the dev split** (balanced, best threshold; shipped:
P 64.2 / R 78.6 / F1 70.7 / FPR 17.0):

| Candidate | Precision | Recall | F1 | FPR | Outcome |
|---|---|---|---|---|---|
| Shipped background, re-tuned threshold | 68.2 % | 75.9 % | 71.8 % | 13.7 % | too small |
| 97-subject taxonomy instead of the 26, cutoff 0.6 | 86.1 % | 78.6 % | 82.2 % | 4.9 % | fails the synthetic gate (broad topics such as "sports", "politics" lose their own sub-topics) |
| **shipped 26 + taxonomy (106), cutoff 0.45** | **86.6 %** | **75.9 %** | **80.9 %** | **4.5 %** | pre-registered candidate |
| topic templates ("{topic} news", "news about {topic}") | ≤ 85.3 % | — | ≤ 80.4 % | — | neutral or worse |
| lexical negation ("no spoilers", "spoiler-free") | — | — | — | — | no effect on dev, no evidence |
| all-MiniLM-L12-v2 (12 layers, 2× CPU, +22 MB) with taxonomy | 65.8 % | 83.4 % | 73.6 % | 16.8 % | worse than L6 + taxonomy |
| gte-small (MIT, 12 layers) | 37.2 % | 92.0 % | 53.0 % | 60.2 % | similarities uniformly high; margin scoring fails |

**Held-out validation.** The candidate, its thresholds and acceptance
criteria were pushed ([PREREGISTRATION.md](evaluation/realworld/PREREGISTRATION.md))
before 14 new pages were captured; their 1,983 texts were labelled and their
checksum published before any prediction was computed. One evaluation,
balanced, English, same data for both
([shipped](evaluation/realworld/RESULTS.md),
[candidate](evaluation/realworld/RESULTS-task04-candidate.md)):

| Held-out | Precision | Recall | F1 | FPR texts | FPR cards |
|---|---|---|---|---|---|
| shipped | 47.0 % | 75.6 % | 58.0 % | 19.3 % | 19.7 % |
| candidate | 62.0 % | 62.8 % | 62.4 % | 8.7 % | 10.2 % |
| — cryptocurrency | 55.5 → 93.1 % | 74.5 → 65.7 % | 63.6 → 77.0 % | 13.8 → 1.1 % | |
| — football | 56.1 → 61.2 % | 67.3 → 49.3 % | 61.2 → 54.6 % | 17.3 → 10.3 % | |
| — movie spoilers | 32.8 → 45.8 % | 95.6 → 88.2 % | 48.9 → 60.3 % | 25.8 → 13.8 % | |

Per page, the candidate cut false positives on silver-price videos for
"cryptocurrency" from 57 % to 3 %, on teaser trailers for "movie spoilers"
from 63 % to 10 % and on basketball for "football" from 58 % to 26 %, but
barely on rugby (25 → 22 %) and spoiler-free reviews (72 → 62 %). In the
browser (same live pages, both builds) a gold-price feed lost 3 instead of
58 texts to "cryptocurrency". Package +0.54 MiB (model.json carries the
background vectors), no measurable change in cold or warm latency.

**Decision: not shipped.** Recall fell to 62.8 %, below the pre-registered
65 % (all other criteria held). Cause: MiniLM places the one-word topic
"football" near sport in general, so 18 sports are excluded as paraphrases,
while "the Olympic Games" and "motor racing and Formula 1" fall below the
cutoff, stay as competitors and beat Serie A highlight titles (24 of 29
football matches lost). A cosine cutoff cannot build a coherent set of
competitors around a weak one-word topic. The implementation is kept as
[task04-candidate.patch](evaluation/realworld/task04-candidate.patch);
`node scripts/evaluate-realworld.ts --config task04-candidate` reproduces
its numbers.

**Smallest viable next step** (implemented in Task 07, next section): make the topic, not a
cosine cutoff, decide what competes — map the user's topic onto an explicit
two-level taxonomy (e.g. sport → association football / rugby / basketball,
finance → crypto / precious metals / stocks), represent it by a few short
descriptions of that node instead of one word, and let only its siblings and
unrelated subjects compete, never its parent or children. It reuses this
encoder and the precomputed-vector mechanism; it needs a new held-out set to
validate.

## Sibling veto (Task 07)

**What it does** (`src/shared/siblings.ts`, `src/shared/topic-siblings.json`).
Six general domains — sports, animals, finance, film and TV, technology,
music — list 58 member subjects ("soccer", "rugby", "basketball" …; "cats",
"dogs", "horses" …) under 11 labels ("sports", "animals", "pets and
animals" …), 69 phrases whose vectors `tools/prepare_model.py` stores in
model.json. For each part of the user's topic (both parts of "football and
basketball"):

1. its most similar member is its *anchor* if cosine ≥ 0.6;
2. if a label of that domain is at least as close (− 0.02), the part is
   *broad* ("sports", "pets") and that domain gives no rivals;
3. the topic, its parts, their anchors and members within 0.1 of an anchor
   (or ≥ 0.8) are the topic's side; the other members of anchored domains
   are its *rivals*.

`decide()` withholds a semantic match when the text's best rival
similarity exceeds *ratio* × its best similarity to the topic's side
(precise 1.2, balanced 1.3, thorough 1.4). Keyword matches are never
withheld; margin scoring, background topics and thresholds are unchanged,
so the veto can only remove matches, and a topic without rivals (no anchor:
"politics", "Elon Musk", "Netflix"; broad: "sports", "movies") behaves
exactly as before. Cost: one extra dot product per rival (≤ 15) per text.

**Why not a cutoff.** A cosine cutoff cannot build the competitors: "cats"
is closer to "kittens" (0.78) than to "dogs" (0.72), "football" closer to
"sports" (0.79) and "American football" (0.83) than to "basketball"
(0.68). Task 04's flat taxonomy therefore dropped rugby and basketball as
"synonyms" of football while "the Olympic Games" and "motor racing" stayed
and beat Serie A titles. The domain list says what is a sibling of what;
the rules above decide only *which* domain a topic belongs to and whether
it is broad. Other choices measured on development data:

| Variant (dev, pooled, balanced) | Precision | Recall | FPR | |
|---|---|---|---|---|
| without the veto | 54.8 % | 80.0 % | 22.0 % | |
| rival > own + d, d ∈ {0, −0.02, −0.04}, topic alone on its side | 69–71 % | 62–71 % | 9–10 % | football recall 44–59 % |
| same, anchor and near members on the topic's side | 71 % | 69–76 % | 9–11 % | two parameters |
| **ratio 1.3, anchor and near members on the topic's side** | **74.9 %** | **77.8 %** | **8.7 %** | shipped |
| + "keep if similarity to the topic ≥ 0.4–0.5" | ≈ same | +0.1 | ≈ same | no effect, dropped |
| without the "movie and TV spoilers" member | 69.1 % | 78.2 % | 11.7 % | spoilers FPR stays 36 % |
| card voting (hide a card only if most texts match) | cards 67.5 % | cards 79.2 % | cards 8.5 % | card recall −5.5, rejected |

Sensitivity: anchor minimum 0.55–0.65, synonym limit 0.75–0.85 and broad
margin 0–0.05 change nothing; rewording 12 members with synonyms costs 0.7
points of recall and 3 of precision (before the "near members" rule it cost
4.6 points of recall — "association football" would have become a rival
of "football").

**Held-out validation** (pre-registered:
[PREREGISTRATION-task07.md](evaluation/realworld/PREREGISTRATION-task07.md)).
22 new pages, captured with no topic active after the pre-registration was
pushed, labelled for 7 topics (basketball, stock market and dogs never used
in development), checksum published before any prediction; one run per
classifier ([with](evaluation/realworld/RESULTS.md),
[without](evaluation/realworld/RESULTS-no-siblings.md) the veto):

| Held-out, balanced, English (2,681 texts) | without veto | with veto | criterion |
|---|---|---|---|
| precision | 44.2 % | 81.1 % | ≥ +8 points ✔ |
| recall | 83.4 % | 82.1 % | ≥ −3.0 points ✔ |
| false-positive rate | 28.7 % | 5.2 % | ≥ 30 % lower ✔ |
| worst topic recall (stock market) | 94.3 % | 88.7 % | ≥ −8 points ✔ (investigated: 3 mixed texts) |
| cards: FPR / recall | 33.0 % / 89.2 % | 6.6 % / 87.3 % | lower / ≥ −4 points ✔ |
| unseen topics: recall / FPR | 90.9 % / 28.8 % | 88.8 % / 4.7 % | ≥ −4 points / lower ✔ |
| synthetic CI gate (F1 / UI FPR) | 63.7 % / 1.8 % | 62.5 % / 1.5 % | ≥ 60 % / ≤ 5 % ✔ |
| warm batch of 24 / package | 680 ms | 680 ms / +0.47 MiB unpacked | < +5 % / < 0.5 MiB ✔ |

Paired bootstrap over (topic, page) clusters, 2,000 resamples (95 %):
precision +25.0 to +46.3 points, recall −3.2 to −0.3, FPR −31.2 to −15.2.
Other modes, held-out: precise P 57.4 → 89.6 %, R 74.4 → 73.7 %, FPR
15.0 → 2.3 %; thorough P 36.9 → 67.0 %, R 89.4 → 88.2 %, FPR 41.6 →
11.8 %. Texts under 40 characters: P 41.9 → 79.0 %, R 47.6 → 47.6 %.

The 8 matches lost: 3 mixed stock-market texts ("Gold and silver prices
seesaw as FTSE 100 hits record high", "Interest Rates FALLING! Nasdaq
SUPPORT levels BREAKING!", "Stocks Fall After Hot Inflation Report"), 3
football texts that name only clubs and players, one dog-breed file name,
one basketball player headline. The veto added no match (by construction).
**Decision: shipped.**

In the browser (same build, Wikimedia Commons "Quality images of dogs",
topic "cats"): 56 of 167 units hidden before, 21 after (9 of them Polish
or Spanish file names, which English metrics exclude).

## Known failure modes

* **Texts about a topic and its sibling** can lose to the sibling ("Bitcoin
  Is LOSING SUPPORT! (Inflation Is Getting WORSE)" for "cryptocurrency",
  "Stocks Fall After Hot Inflation Report" for "stock market").
* **Words with two meanings** in a sibling's name: "Ethereum gas fees
  dropped" is closer to "oil and gas prices" than to "cryptocurrency".
* **Domains the sibling list does not cover** (politics, people, places,
  hobbies) keep the older behaviour: close neighbours are confused.

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

## Image model (image filtering)

Used only when *Images* is enabled; independent of the text encoder above.

| | |
|---|---|
| Model | SigLIP base, patch 16, 224 px — `google/siglip-base-patch16-224` @ `7fd15f0689c7` (Apache-2.0) |
| Files shipped | int8 dynamically quantised ONNX export from `Xenova/siglip-base-patch16-224` @ `4649052661e5`: image encoder 94.9 MiB, text encoder 106.3 MiB, SentencePiece `tokenizer.json` 2.3 MiB; sha256 + size pinned in `tools/vision_model_lock.json` |
| Runtime | ONNX Runtime Web 1.30.0 (non-bundled build), WebAssembly SIMD, up to 4 threads (half the logical cores; 13.6 MiB `.wasm` + 24 KB glue), in dedicated workers of the cross-origin-isolated offscreen document |
| Embedding | 768-d `pooler_output`, L2-normalised; image and text in one space (contrastive image–text pre-training with a sigmoid loss on WebLI) |
| Preprocessing | RGB, resize the whole picture to 224 × 224 (no crop, as trained), ×1/255, mean 0.5, std 0.5, NCHW float32 (`src/vision/preprocess.ts`) |
| Text | lowercase, ASCII punctuation removed, whitespace collapsed (SigLIP's canonicalisation), SentencePiece Unigram, `</s>`, padded to 64 with `</s>` (the model has no attention mask); `src/vision/siglip-tokenizer.ts` |

**Why this model.** Two candidates were measured in Chromium on the
development photos with the same code (`docs/evaluation/vision/PREREGISTRATION.md`):
OpenAI CLIP ViT-B/32 int8 (MIT; 154 MB; 155 ms per picture; dev mAP 0.897;
its model card calls deployed use out of scope) and SigLIP base/16 int8
(Apache-2.0; 211 MB; 575 ms; dev mAP 0.954). With the generic-background
rule SigLIP reached F0.5 0.91 vs 0.80 (CLIP missed all "cars", which it could
not separate from "a vehicle"). SigLIP was chosen for quality and licence.
MobileCLIP-S0 would be smaller and faster but its weights are under Apple's
research-only licence. Larger or fp16 variants were not considered (size).

**Correctness.** Tokenizer: identical ids to the reference `tokenizers`
implementation on 18 edge cases (`tests/fixtures/siglip_tokenizer_parity.json`).
Text encoder (int8, WebAssembly, Node) vs PyTorch fp32: cosine 0.968–0.989.
Image path in the extension (Chrome's decoding and resampling + int8) vs
PyTorch fp32 with PIL bicubic preprocessing: cosine 0.944–0.976 on the ten
test photos, and the same best-matching prompt for every photo
(`tests/e2e/vision.test.ts`). The decision rule was calibrated on the int8
outputs, so the quantisation error is inside the measured quality.

**Decision rule and quality.** `src/shared/vision.ts` (two conditions:
similarity floor and margin over 22 generic background descriptions);
calibration, held-out results, per-topic numbers and known confusions:
`docs/evaluation/vision/RESULTS.md`. SigLIP's own sigmoid calibration
(scale 117.3, bias −12.93) gives match probabilities below 0.001 for these
generic prompts, so its scores are not shown or used as probabilities.

**Determinism.** The int8 model quantises activations with one scale per
tensor; prompts are therefore always embedded one at a time, never batched,
so a topic's embedding does not depend on other topics. Image inference is
always one picture per run.
