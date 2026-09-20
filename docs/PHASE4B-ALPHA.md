# Practical English-first alpha (0.3.1)

Use the existing topics, strictness, pause, site rules and click/Enter/Space reveal. English works best. Images remain experimental and off by default, as do extra image downloads.

## Local feedback

On an active public page, open the toolbar popup and choose **Report a text filtering mistake…**. Click a text item, or use Previous/Next and Choose with the keyboard. Select the enabled topic, optionally include diagnostics, then save. Escape or Close cancels; the picker expires after two minutes and closes when settings change. It blocks link activation and reveal during picking. Feedback does not retrain the model, override filtering or mark anything as a confirmed label.

A hidden or previously revealed text item is reported as **Wrongly hidden**. A visible item is reported as **Should be hidden**. Image-only feedback is deferred: image ownership, pixel consent and related-text decisions need a separate workflow. Text units inside hidden feed cards are reported with their observed card visibility. A nonmatching unit inside a hidden card is not necessarily a classifier error.

Settings shows the latest ten reports. Export JSON and Delete all are explicit actions. Storage is local, limited to 100 records and approximately 200 KB maximum by schema bounds. Records expire after 30 days and are pruned when the service worker wakes or feedback is read/saved. An inactive browser cannot run expiry code; expiry is not a secure erasure guarantee. Exported files remain wherever you save them; deleting extension feedback does not delete exports.

Basic records include the selected topic, mode, observed visibility, tag/ordinal, version, timestamp and a random report ID. Optional diagnostics add a bounded tag/nth-of-type path, analysis state, best-topic decision scores and backend. Scores describe the best decision across enabled topics, not necessarily the topic selected in the report. Unanalysed items have null scores. No page text, hashes of text, URLs, host names, IDs/classes, HTML, screenshots, image pixels/URLs, passwords, input values, private messages or account fields are collected by this workflow. Existing site exclusions and protected areas still apply. Log/textbox regions and hidden/inert areas cannot be selected. No new permissions, telemetry, inference endpoint or automatic external transmission.

Content-free reports are deliberately insufficient to reproduce semantic mistakes alone. Privately associate a report ID with your example while it is still visible. If sharing for review, manually supply a minimal **public**, nonpersonal reproduction and exact topic intent, mode, observed target, version and backend. Never paste private conversations, input fields, account details or personal URLs. Check any export before sharing: user-configured topic names may be personal. The extension does not remember a page address for you.

## Review workflow

`build/phase4b-evidence/REVIEW-QUEUE.json` derives all 35 IDs from the Phase 3B candidate ledger and Phase 3C issue register, retaining provenance hashes without copying third-party text or URLs. Historical snapshot evidence remains in the original local directories. No Task04/Task07 holdout is opened or used. Existing historical Task03 inspection does not become a new blind sample.

Keep four distinct categories, using separate mechanical-evidence and relevance-review fields:

1. **Verified deterministic defect**: exact steps and assertions demonstrate a mechanical failure. Phase 4B's lost topic draft and nested-link keyboard activation are repaired and tested. Extraction floors/truncation are reproduced boundaries but unchanged classifier limitations.
2. **Human-confirmed relevance mistake**: a real person records intent, context, judgment, reviewer and date. None have been obtained in this milestone. A user clicking feedback creates an unreviewed report, not automatically this category.
3. **Provisional AI judgment**: an assistant's suspicion or authored/model-generated expectation, clearly attributed. Never independent accuracy evidence.
4. **Unreviewed observation**: a captured decision, blur state or submitted report awaiting review. Unknown is not negative.

To review: start with one ledger ID or local report ID; verify the mechanical reproduction, record intended topic scope, then have a human judge relevance using public context before inspecting model scores. Preserve disagreement and ambiguous labels. Keep a separate fresh publisher-grouped holdout sealed for future evaluation. Do not tune thresholds or keyword exceptions from this queue. No accuracy improvement is claimed by adding feedback.

## Supported scope and limitations

Prior validated anonymous alpha snapshots: BBC News/Sport, Guardian football, Cats Protection, desktop CoinDesk, Yahoo Finance and YouTube cards. These are observations, not permanent compatibility guarantees. Consent/challenge/login shells are not successful integrations: Reddit and X remain unvalidated, Oracle YouTube was consent-limited, Oracle CoinDesk checkpoint-limited. No accounts or normal browser profiles are used in controlled validation.

MiniLM weights, semantic thresholds, background margins, sibling vetoes and text floors remain unchanged. Known cats/football, musical Cats and association-football/NFL scope mistakes remain. Very short headings, a relevant suffix after the first 1,000 extracted characters, the 126-content-token encoder limit, mixed-topic cards and spoiler intent remain limitations. Reveals persist for unchanged text until pause/restart resets the page controller; they are not permanent allow rules. Pause and site exclusions restore page markup. CPU fallback remains supported; NVIDIA WebGPU claims require an actual nonfallback hardware adapter. No model research or public release is part of Phase 4B.
