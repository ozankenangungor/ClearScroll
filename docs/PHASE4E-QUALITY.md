# Targeted quality controls (0.3.4)

Each topic has optional **Text exclusions** in Settings. Enter literal phrases,
one per line, to leave that topic unmatched in text containing a phrase. For
example, a topic `jaguar` can exclude `car review`. Matching ignores case,
accents and repeated whitespace, uses whole phrase boundaries, and treats
punctuation literally. There is no stemming or interpretation of negative
instructions. Up to ten phrases of 120 characters are allowed per topic.

This is a text-only scope control. A mixed unit containing an exclusion is
left unmatched for that topic even if it also discusses the desired subject.
Another matching topic or another unit in a matching parent card can still
hide it. Image classification is unchanged. Only the extracted text (first
1,000 characters) is tested, so a later exclusion may be unseen. These controls
stay in local settings. Empty exclusions preserve existing behavior.

There are no built-in assumptions that `football` means soccer or that `cats`
means animals. A user can explicitly exclude `NFL` from a football topic or
`musical` from a cats topic. Those lists are incomplete literal guards, not
complete semantic sense classifiers: text that does not contain the phrases
can still match incorrectly, and a soccer article discussing the NFL may be
left visible. Broad football users should keep exclusions empty.

Phase4E rejected its short explicit-phrase rescue: although it recovered short
headings, it newly hid a spoiler-policy control. The bounded selective-tail
experiment also introduced false positives. Semantic length floors, model
weights, inference windows and card extraction remain unchanged.

The full private development comparison, all-mode production decisions,
Oracle checks, desktop validation and artifact hashes are saved under
`build/phase4e-evidence/`. AI annotation agreement is a development diagnostic,
not human ground truth or a population accuracy estimate. Protected blind
holdouts were not used.
