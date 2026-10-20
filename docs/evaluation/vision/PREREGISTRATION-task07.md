# Pre-registration: sibling veto for pictures (Task 07)

Written and committed **before** any photo of the held-out set below was
downloaded, labelled or scored. Nothing here may change after the held-out
run; deviations are reported, not edited in.

## Candidate (chosen on development photos only)

Commit `5ef6528`. For a topic whose text sibling plan (src/shared/siblings.ts,
MiniLM, validated on text in Task 07) has rivals:

1. Rivals and anchors are embedded by the image model's text encoder (mean of
   the three prompt templates), precomputed at build time in
   `vision/background.json`.
2. A picture is **not hidden** for the topic when its best similarity to a
   rival exceeds its best similarity to the topic and its anchors.
3. The topic uses `VISION_SIBLING_RULES` — precise {0.04, 0} (unchanged),
   balanced {0.03, −0.02}, thorough {0.02, −0.02} — chosen on the pooled
   dev + val photos by F1 (balanced) and F2 (thorough) over
   minSimilarity ∈ {0.05, 0.04, 0.03, 0.02} × minMargin ∈ {0.005 … −0.02}.

Topics without rivals, a keyword-only text engine, or a plan not ready
within 3 s keep the Task 06 rules (`VISION_RULES`), without a veto.

Development photos (dev 245 + val 223; both inspected in Tasks 05–06, so
development data now), `node scripts/evaluate-vision.ts [--no-siblings]`:

| Pooled dev + val | Precision | Recall | False positives |
|---|---|---|---|
| precise, Task 06 → candidate | 0.930 → 0.966 | 0.778 → 0.774 | 15 → 7 |
| balanced, Task 06 → candidate | 0.926 → 0.967 | 0.829 → 0.903 | 17 → 8 |
| thorough, Task 06 → candidate | 0.926 → 0.948 | 0.829 → 0.918 | 17 → 13 |

Neighbouring-subject false positives (balanced): 13 → 3. Applying the loose
rule to every topic (also those without rivals) was rejected on dev:
politics false positives 2 → 9, airplanes 2 → 5.

## Held-out photos (downloaded after this file is committed)

Openly licensed Wikimedia Commons photos (CC0, public domain, CC BY,
CC BY-SA), 500 px thumbnails, via the Commons search API with the queries
below (never used before), first 12 usable results per query, excluding any
photo already in the dev or val set (by page and by sha256). Labels are
assigned by looking at contact sheets **before any model is run on the
photos**, with the Task 05 rules (search mislabels relabelled or removed;
genuinely unclear subjects marked ambiguous). The manifest's sha256 is
recorded before scoring.

| Category | Queries |
|---|---|
| cat | "domestic cat portrait", "tabby cat sitting" |
| dog | "dog on a leash", "puppy portrait" |
| horse *(new neighbour)* | "horse in a paddock" |
| bird *(new neighbour)* | "garden bird on a branch" |
| football | "association football match tackle", "soccer goalkeeper save" |
| rugby | "rugby lineout", "rugby tackle match" |
| basketball | "basketball dunk game", "basketball players court" |
| tennis *(new neighbour)* | "tennis player serve" |
| crypto | "bitcoin coin physical", "cryptocurrency ATM" |
| gold | "gold bullion bars" |
| stocks | "stock ticker display", "trading floor traders" |
| car | "car parked street", "sedan automobile" |
| airplane | "airliner taking off", "aircraft landing" |
| protest | "street protest march placards" |
| portrait | "person portrait outdoors" |
| food | "hamburger and fries", "pizza slice" |
| objects | "kitchen utensils", "office desk items" |
| landscape | "mountain lake landscape" |

Topics and positives as in `scripts/evaluate-vision.ts` (EVAL_TOPICS); the
new categories horse, bird and tennis are negatives for every topic.

## Acceptance criteria (held-out photos, same frozen data for both)

`--no-siblings` (Task 06 rules) versus the candidate, each run once. Ship
only if **all** hold:

1. **Balanced:** recall rises by at least 4 points and precision falls by
   at most 1 point.
2. **Balanced:** neighbouring-subject false positives do not increase.
3. **Precise:** precision does not fall and recall falls by at most 2 points.
4. **Thorough:** recall does not fall and precision falls by at most 3 points.
5. **Per topic (balanced):** no topic's recall falls by more than 10 points
   and no topic gains more than 2 false positives.
6. **All ten topics active (balanced):** unrelated photos hidden increase by
   at most 1.
7. Image latency unchanged (same model and inference path); package growth
   below 1 MiB.

If any criterion fails, the image veto and its rules are switched off (the
text sibling veto is unaffected) and the evidence is reported.
