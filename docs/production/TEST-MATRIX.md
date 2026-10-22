# Test matrix

Exact current results and failures are in build/040-production-readiness/TEST-RESULTS.md and logs/*.exit. Do not infer a pass from this coverage list.

| Layer | Scope |
| --- | --- |
| Source | TypeScript types/unit; Rust CPU/tokenizer/embedding parity; complete DOM controller/image/feedback lifecycle tests |
| Frozen035 | All 49 original E2E tests, including optional image pipeline; all four original differential privacy modes |
| Text package | All text E2E files, accessibility and keyboard tests; production clean-install/UI mode test; no image-only claim |
| Chrome Stable CPU | Actual semantic filtering, auto fallback, reveal, pause, site rules, feedback, exports/deletion, worker/browser restarts |
| Chrome Stable NVIDIA | Actual nonfallback adapter identification and engine execution, same journeys/stress/performance |
| Lifecycle | 80 cycles, removal/reinsertion, cross-card move, same-card reorder, unrelated neighbor, detach/pause, pending and cache bounds |
| Privacy/security | No-op differential NetLogs, offline filtering, local feedback schema, explicit export/deletion, self-only CSP, no permission escalation |
| UI | 1280×800 clean-profile screenshots of real onboarding/settings/blur/reveal; no fabricated UI |
| Artifact | Two clean assemblies, locked model hashes, exact content/ZIP comparison and source/artifact inventories |
| Unavailable platforms | Windows/macOS not tested; no fabricated certification |

Omitted candidate E2E files are cold-start.test.ts, vision.test.ts and text-image.test.ts: they require omitted SigLIP/ORT assets and pixel-level behavior. They are retained and run against frozen035, not deleted. Text-card media ownership, neighbor integrity, dynamic cards and all existing text files remain in the candidate suite. Failure and disable/enable checks have their own evidence; see the final report for precise applicability.
