# 0.3.3: preserve rendered line-break boundaries

A paragraph such as `blue<br>moon` was sent as `bluemoon`. This could miss the exact phrase `blue moon` or manufacture a match for a word joined across a break. Text extraction now treats HTML BR as whitespace before existing normalization and length bounds. Formatting spans and WBR still preserve word continuity. The page DOM is never rewritten, and insertion/removal of a break invalidates the old decision through the existing mutation path.

This fixes a deterministic extraction error, not general semantic accuracy. Classifier thresholds, rules, MiniLM weights, topic interpretation, privacy, image behavior and inference limits are unchanged. Units without BR retain the previous text path. CSS-dependent visibility is not reconstructed by this change.

The frozen 0.3.2 alpha and its Phase 4D evidence remain available separately. The 32-case semantic review uses explicitly AI-generated development annotations, with two blinded rubric passes and separate disagreement/ambiguity reporting. No human labels, population accuracy or protected-holdout validation are claimed. Ordinary private alpha usage does not depend on recruiting reviewers or filling in an annotation interface.
