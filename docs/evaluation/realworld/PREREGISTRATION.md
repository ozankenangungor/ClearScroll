# Pre-registration: reducing false positives (Task 04)

Written and pushed **before** the held-out pages below were captured or
labelled. Nothing in this file may be changed after the held-out evaluation;
deviations are reported, not edited in.

## Candidate (chosen on eval/realworld dev only)

Same encoder (all-MiniLM-L6-v2, f16) and margin scoring; two changes:

1. **Background topics**: the shipped 26 generic topics plus a broad general
   content taxonomy of 97 subjects (sports, finance, technology,
   entertainment, news, everyday life, page furniture) — 106 distinct
   topics, listed in `candidate-background-topics.json`. A text matches only if it is closer to the user's topic than to
   every competing subject.
2. **Paraphrase cutoff 0.45** (was 0.5): background topics at least this
   similar to the user's topic are treated as the same subject and do not
   compete.

Thresholds (margin), calibrated on the dev split with the existing per-mode
objectives (F0.5 / F1 / F2): precision −0.015, balanced −0.045,
aggressive −0.105.

Dev results (in-sample, therefore optimistic), balanced, English:
shipped P 64.2 / R 78.6 / F1 70.7 / FPR 17.0 → candidate
P 86.6 / R 75.9 / F1 80.9 / FPR 4.5.

Rejected on dev: topic templates ("{topic} news", "news about {topic}") —
neutral or worse; a lexical negation rule ("no spoilers", "spoiler-free") —
no effect on dev, so no evidence for it; all-MiniLM-L12-v2 (dev F1 ≤ 73.6
with the same taxonomy, 2× CPU cost); gte-small (similarities uniformly
high; margin scoring fails, best dev precision 37 %).

## Held-out set (new pages, captured after this file is pushed)

Captured with `scripts/live-capture.ts` (which now records each text's
card), at most the first 120 distinct text units per page in document order,
labelled by hand following `eval/realworld/GUIDELINES.md` from the text
alone, before any prediction on them is computed.

| Category | Topic | Pages |
|---|---|---|
| crypto vs gold / stocks | cryptocurrency | coindesk.com; theguardian.com/business/stock-markets; YouTube "crypto market news today"; YouTube "silver price news" |
| football vs rugby / basketball | football | theguardian.com/football; bbc.com/sport/rugby-union; YouTube "serie a highlights"; YouTube "euroleague basketball highlights" |
| spoilers vs film/TV and spoiler-free | movie spoilers | YouTube "movie twist ending breakdown"; YouTube "spoiler free review 2026"; YouTube "official teaser trailer"; theguardian.com/culture |
| unrelated news and navigation | all three topics | bbc.com (home page); theguardian.com/uk |

Short headlines and titles are reported as the subset of texts shorter than
40 characters.

## Acceptance criteria (held-out, balanced, English, same frozen data for both)

Ship the candidate only if **all** hold:

1. Overall precision improves by at least 10 points over the shipped
   classifier.
2. Overall recall is at least 65 %.
3. False-positive rate improves for every topic.
4. Card-level false-positive rate (cards hidden although none of their texts
   is on the topic) improves overall.
5. The synthetic CI quality gate passes with its unchanged minimums
   (English F1 ≥ 0.60, UI-string FPR ≤ 0.05) at the shipped thresholds.
6. No startup, memory, privacy or package-size regression beyond model.json
   growing by the precomputed background vectors (< 1 MB).

The product targets (overall FPR < 20 %, precision ≥ 70 %, recall ≥ 65 %)
are reported against, but are goals, not the ship rule. If the candidate
fails any criterion it is not shipped and the trade-offs are reported.
