# Pre-registration: sibling veto (Task 07)

Written and pushed **before** any page of the held-out set below was
captured or labelled. Nothing in this file may be changed after the
held-out evaluation; deviations are reported, not edited in.

## Problem (development data)

On the four development splits (`dev`, `test`, `heldout` of Tasks 03/04 —
all inspected before, so development data now — and the new `task07-dev`
for the topic "cats"), the shipped classifier's false positives are
dominated by neighbouring subjects: rugby and basketball for "football",
gold, stocks and inflation for "cryptocurrency", dogs and horses for
"cats" (on a Wikimedia Commons dog gallery 56 of 167 units were hidden for
"cats"), trailers and reviews for "movie spoilers". Cause: background
topics at cosine ≥ 0.5 to the user's topic are dropped as near-synonyms,
so nothing speaks for those neighbours, and a cosine cutoff cannot pick
them ("cats" is closer to "kittens" 0.78 than to "dogs" 0.72; "football" is
closer to "sports" 0.79 than to "basketball" 0.68). Task 04's larger flat
taxonomy failed for that reason (docs/MODEL.md).

## Candidate (chosen on development data only)

Shipped classifier unchanged (encoder, 26 background topics, cutoff,
thresholds, keyword rules) **plus a sibling veto** (`src/shared/siblings.ts`,
`src/shared/topic-siblings.json`, `siblingRatio` in `src/shared/models.ts`):

1. Six general domains (sports, animals, finance, film and TV, technology,
   music) with 58 member subjects and 11 group labels (69 phrases), embedded at
   build time (`tools/prepare_model.py` → model.json).
2. Each part of the topic ("football", or "football" and "basketball" in
   "football and basketball") is anchored to its most similar member if
   cosine ≥ 0.6. A part at least as close (− 0.02) to its group's label as
   to its anchor is broad ("sports", "pets"): that group gives no rivals.
3. The topic, its parts, their anchors and members within 0.1 of an anchor
   (or ≥ 0.8) are the topic's side; the other members of anchored groups
   are rivals. No rivals → behaviour identical to before.
4. A semantic match is withheld when the best rival similarity exceeds
   *ratio* × the best similarity to the topic's side; keyword matches are
   never withheld. Ratio per mode: precise 1.2, balanced 1.3, thorough 1.4
   — per mode the smallest value in {1.2, 1.3, 1.4, 1.5} whose pooled dev
   recall loss is ≤ 2.5 points.

Development results (in-sample, therefore optimistic), English, pooled
dev + test + heldout + task07-dev, 4,957 texts, `node scripts/evaluate-realworld.ts
--splits dev,test,heldout,task07-dev --pool dev-pool --config no-siblings|shipped`:

| Balanced | Precision | Recall | F1 | FPR |
|---|---|---|---|---|
| without veto | 54.8 % | 80.0 % | 65.0 % | 22.0 % |
| **candidate** | **74.9 %** | **77.8 %** | **76.3 %** | **8.7 %** |
| — football | 62.3 → 82.0 % | 73.8 → 72.4 % | | 22.6 → 8.1 % |
| — cryptocurrency | 61.0 → 97.2 % | 78.5 → 74.2 % | | 13.0 → 0.6 % |
| — movie spoilers | 40.7 → 50.6 % | 90.2 → 88.2 % | | 36.0 → 23.6 % |
| — cats | 54.7 → 87.0 % | 94.9 → 94.9 % | | 18.0 → 3.2 % |
| cards | 48.8 → 66.3 % | 87.9 → 84.7 % | | 20.4 → 9.5 % |
| precise mode | 61.7 → 80.2 % | 69.0 → 66.8 % | | 14.3 → 5.5 % |
| thorough mode | 47.7 → 67.2 % | 89.9 → 87.5 % | | 32.9 → 14.3 % |

Synthetic CI set (`scripts/evaluate.ts`, unchanged thresholds): English
balanced F1 63.7 → 62.5 %, UI-string FPR 1.8 → 1.5 % (gate: ≥ 60 %, ≤ 5 %).

Known cost on dev: cryptocurrency texts that are also about stocks,
inflation or gold ("CPI LIVE … XRP, Bitcoin, Stocks & Gold") lose to the
rival (crypto recall −4.3 points).

Rejected on dev: a margin rule (rival − own > d, with or without a minimum
rival similarity) — same trade-off with two parameters instead of one; an
absolute "keep if similarity to the topic ≥ x" exemption — no effect;
competing against the anchor alone without its near members — football
recall 59 %; card-level voting (hide a card only if most of its texts
match) — card FPR 9.5 → 8.5 % for card recall 84.7 → 79.2 %; without the
spoiler member, "movie spoilers" keeps FPR 36 %. Sensitivity: anchor
minimum 0.55–0.65, synonym limit 0.75–0.85 and broad margin 0–0.05 change
nothing on dev; rewording 12 members with synonyms (e.g. "soccer" →
"association football") costs 0.7 points of recall and 3 of precision.

## Held-out set (captured after this file is pushed)

Captured with `scripts/live-capture.ts` in Google Chrome stable with **no
topic active** (so no verdict exists), at most the first **100** distinct
text units per page in document order, with the card of each text, labelled
by hand from the text alone following `eval/realworld/GUIDELINES.md`
(including the Task 07 sections for cats, dogs, basketball and stock
market, written before capture). The labelled file's sha256 is committed to
`eval/realworld/MANIFEST.json` and pushed before any prediction on it is
computed. Each page is labelled for the topics listed with it.

| Topics | Pages |
|---|---|
| football, basketball | bbc.com/sport/cricket; theguardian.com/sport/nba; theguardian.com/football/premierleague; YouTube "champions league goals"; YouTube "nba top 10 plays"; YouTube "atp tennis highlights" |
| cryptocurrency, stock market | theguardian.com/business/economics; theguardian.com/technology/bitcoin; YouTube "solana news today"; YouTube "nasdaq stock analysis"; YouTube "gold price forecast" |
| cats, dogs | commons.wikimedia.org Category:Featured_pictures_of_cats; Category:Featured_pictures_of_dogs; theguardian.com/lifeandstyle/pets; YouTube "cute kittens playing"; YouTube "puppy compilation"; YouTube "parrot talking" |
| movie spoilers | YouTube "season finale explained"; YouTube "new movie trailer 2027"; YouTube "honest movie review" |
| football, cryptocurrency, cats, movie spoilers | theguardian.com/world |
| basketball, stock market, dogs | bbc.com/news/world |

Topics "basketball", "stock market" and "dogs" were never used during
development (unseen topics: does the veto generalise?). No page was used in
any earlier split.

## Acceptance criteria (held-out, balanced, English, same frozen data for both)

Compared: `--config no-siblings` (the classifier at b9c528d) and
`--config shipped` (the candidate), each run once. Ship the candidate only
if **all** hold:

1. Text-level false-positive rate falls by at least 30 % (relative).
2. Precision rises by at least 8 points.
3. **Recall floor**: overall recall falls by at most 3.0 points (dev:
   −2.2).
4. No topic's recall falls by more than 8 points (dev worst: −4.3); a
   topic losing more than 5 points is investigated and reported.
5. Cards: card-level FPR falls, and card-level recall falls by at most 4.0
   points.
6. Unseen topics (basketball, stock market, dogs) pooled: recall falls by
   at most 4.0 points and FPR falls.
7. The synthetic CI gate passes unchanged (English balanced F1 ≥ 0.60,
   UI-string FPR ≤ 0.05).
8. No classification-latency regression above 5 % in
   `scripts/benchmark.ts` and package growth below 0.5 MiB.

Reported but not part of the ship rule: precise and thorough modes, texts
under 40 characters, per page, a paired bootstrap over pages (2,000
resamples) for the differences. If any criterion fails the candidate is not
shipped: the veto is switched off (`siblingRatio` removed), the evidence is
reported, and the held-out set becomes development data.
