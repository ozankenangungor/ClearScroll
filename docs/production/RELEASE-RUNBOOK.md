# Local release and eventual publication

1. Read build/040-production-readiness/PRODUCTION-READINESS-REPORT.md and BLOCKERS.md. Only an accepted exact artifact is eligible. A comparison/debug package is not a candidate.
2. Verify required baseline and protected artifact hashes. Work only on release/0.4.0-production-candidate, from a15a9136610fe4d0a132656e22397573f9cefa3d. No rejected experimental change may be merged.
3. Use pinned Node/Rust/wasm-bindgen/esbuild inputs, npm ci and the model lock. Follow REPRODUCE.md in the evidence directory. Never use an old generic dist directory. Build two clean output directories, validate both, package with explicit input/output paths, and compare all files and ZIP bytes.
4. Run complete source unit/Rust/parity/DOM suites. Run the complete applicable text E2E suite against the exact final artifact. Keep full frozen baseline/image regression and differential privacy evidence separately; image-only tests do not qualify a text package. Run candidate text/feedback privacy and CPU/nonfallback NVIDIA journeys, lifecycle, performance and screenshots in disposable profiles.
5. Freeze source and artifact identity; verify no protected bytes changed; inventory files and evidence; commit locally and leave Git clean. Do not install into protected profiles. A failed mandatory gate blocks acceptance.

## Source recovery and later publisher actions (not performed)

Observed remote main is 844d94a363150419a477dfefc740af310c733eb5 (IdeaBlocker 0.2.0). It is an ancestor of the frozen035 baseline, 67 commits behind; zero remote-only commits at audit. Preserve the local branch history, source snapshot, locks, model hashes and all release evidence on developer-controlled backup storage. Re-check the live remote before any future authorized synchronization.

The publisher must separately authorize a source review and push/merge to synchronize public main with the accepted local release. Do not force-push/rewrite history or expose private evidence/evaluation text, browser profiles, model caches or credentials. Review the 67 historical commits as well as the production delta before public synchronization. The model package is delivered through the release artifact; large local/evaluation assets remain ignored. No PR, push, merge or public release is authorized by this runbook.

After synchronization, register/verify the Chrome Web Store developer account, host the privacy/support documents, complete dashboard privacy/permission and distribution fields, upload the exact accepted ZIP, existing128px icon and final actual UI screenshots, and submit for Google's review under new authorization. Review the then-current policies. There is no automatic public publication, login, deployment or submission in this task. Local engineering review cannot guarantee Google's approval.
