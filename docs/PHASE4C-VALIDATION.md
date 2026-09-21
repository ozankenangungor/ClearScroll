# Phase 4C desktop privacy and feedback validation

Phase 4B 0.3.1 remains preserved at commit `da292642c89ec95af4066f848f1aaae75ac5d42e` and its original ZIP. The focused candidate is 0.3.2. Models, thresholds, permissions, inference and Phase 1 lifecycle behavior are unchanged.

The desktop differential failure reproduced. Raw NetLog identifies `update_client` annotation 54845618, `activity_reporter-157.0.8103.38`, the Chrome-activity application ID, POST, and no renderer origin. This is Chrome browser activity reporting through an update endpoint, not proof of a software update. The matching Chrome revision calls it from desktop session-end handling. The old feedback run alone generated mouse/keyboard activity. Fresh no-extension controls with matched input also produce this report; scheduling and shutdown variability remain visible.

The gate retains raw NetLogs, process inventories and command lines, matches navigation/input schedules, and reports this narrowly fingerprinted browser activity separately. Extension-origin requests still fail even to the same endpoint with spoofed headers; missing or changed fingerprints stay subject to the differential assertion. No Google-domain whitelist or browser-service suppression was added. External DNS is blocked; these are attempted-request observations, not a claim about successful payload transmission. CDP target/initiator and process evidence for the repeated comparisons lives in the Phase 4C evidence directory. Original Phase 4B per-request process IDs are unavailable because its harness deleted the NetLogs.

Feedback has a fixed tag vocabulary in 0.3.2. Unknown/custom DOM tags become `element`, including ancestor path segments: arbitrary tag names can contain tokens. Old records carrying unknown tags are rejected on the next cleanup. Nonfinite timestamps are rejected. Standard targets keep their ordinal and bounded diagnostic path. An `element` path segment denotes a redacted tag, not a literal CSS selector. Saved files exported before upgrading cannot be recalled.

Reports include selected topic name/ID, kind, observed visibility, filter mode, tag/ordinal, UUID, timestamp and extension version. Optional diagnostics add up to six tag/ordinal path segments, analysis status, best-enabled-topic match/method/score/similarity/veto and backend/state. No page text, URL, arbitrary attributes, input values, cookies, images or history are copied. Topic names may be personal. Scores and DOM structure are derived information; choose public items and review exports before sharing. Plain private-message paragraphs cannot universally be recognized as private by markup. Diagnostics remain separately opt-in, and exporting requires an explicit action.

The latest 100 records persist locally. Expiry is checked on service-worker start and feedback read/save; it is not a deadline alarm. A sleeping worker, inactive open browser, or closed browser can retain expired records until that activity. Deletion removes logical records, not exported files, backups or filesystem remnants.

A report alone deliberately cannot reconstruct page content or complete topic configuration. For a reproducible review, associate its UUID with a stable public case ID and a separately reviewed minimal public reproduction, exact enabled topics/scope, browser version and extension version. The Phase 4C demo does this for cats/football, association-football/NFL, short cat headings, late-topic text and mixed-topic content. Automated actions and priorities are provisional; human label/reviewer fields remain null. No independent precision/recall claim or holdout access follows.

Oracle verification (after building the candidate and sourcing the existing local toolchain):

```sh
source build/phase0-evidence/oracle-env.sh
export CLEARSCROLL_DIST="$PWD/build/phase4c-evidence/unpacked"
npm run check
npm run test:dom
npm run test:e2e
node scripts/validate-dist.mjs "$CLEARSCROLL_DIST"
npm run verify:privacy
npm run verify:privacy:feedback
npm run verify:privacy:images
```

On the authorized desktop, use a fresh profile through the existing launch helper, `CLEARSCROLL_BROWSER=chrome CLEARSCROLL_SANDBOX=1` and `--browser chrome` for the privacy script. `--probe-egress` deliberately attempts a synthetic extension-origin request under blocked DNS and **must exit 1**. It is a negative control, never a product feature.

Full measured results, preserved failures, hashes, final source identity, browser validation and limitations: `build/phase4c-evidence/REPORT.md`. Evidence is local/ignored and has not been published.
