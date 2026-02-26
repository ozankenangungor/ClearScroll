# Real-world evaluation data

Text units captured with the built extension from public web pages and
labelled by hand, used to measure what users actually see.

**The labelled texts are not in this repository.** They are excerpts of
third-party pages (headlines, video titles and descriptions). What is
public:

* `GUIDELINES.md` — how texts were captured and labelled;
* `MANIFEST.json` — the identity of each split (sha256, size, capture date,
  per-topic counts, source pages); `scripts/evaluate-realworld.ts` refuses
  any data that does not match it;
* `../../docs/evaluation/realworld/` — the pre-registration, the
  calibration record and aggregate results (no texts);
* `scripts/live-capture.ts` and `scripts/evaluate-realworld.ts` — the
  capture and evaluation tools.

## Running the evaluation

Place the private files (`dev.jsonl`, `test.jsonl`, `heldout.jsonl`) in
`eval/private/realworld/` (gitignored) or point `CLEARSCROLL_EVAL_DATA` at
their directory, then:

```bash
cargo build --release --no-default-features --features cli
node scripts/evaluate-realworld.ts --splits heldout,dev --out docs/evaluation/realworld/RESULTS.md
node scripts/evaluate-realworld.ts --splits heldout --config previous   # the classifier before Task 04
```

Ask the maintainer for the files; anyone can build a comparable set with
`scripts/live-capture.ts` and the guidelines.

## History

Until Task 04 the dev and test splits were committed here
(`eval/realworld/dev.jsonl`, `test.jsonl`, commits `1ad6b67` – `1b0e7a0`).
Removing them in a later commit does not erase them from the repository
history: they remain readable in those earlier public commits. Rewriting
published history was deliberately not done.
