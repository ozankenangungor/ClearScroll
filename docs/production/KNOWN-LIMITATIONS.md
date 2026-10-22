# Known limitations

- Best-effort topic matching can miss relevant text or blur unrelated text. Scope and word-sense ambiguity remain. No perfect blocker, parental-control or security guarantee.
- English-only text model; weak short headings and long-text truncation remain. The text window is bounded. No classifier/threshold/rule research is introduced here.
- YouTube video/Shorts preview escape remains unresolved. New installs visibly exclude youtube.com/youtu.be. Existing settings are preserved; keep/add exclusions for unsupported sites. Removing them is experimental, with no preview guarantee.
- No pixel-level image classification, audio/video understanding or guaranteed spoiler detection in this package. A whole text-matched card can include its media.
- Text may appear before processing or while the local model initializes. “0 hidden” is not proof that a page is fully checked.
- CPU fallback is supported; hardware, driver and browser support govern WebGPU. Unsupported or numerically rejected GPU execution falls back. Single-item GPU latency may be worse.
- Restricted Chrome/Web Store pages, PDFs, embedded frames, closed shadow roots and arbitrary future site layouts are unsupported. Exclusions cover whole domains/subdomains, not URL paths. Public suffixes are not validated by a bundled suffix list.
- Automatic cleanup on pause is supported. After extension disable/remove/update, reload pages if orphaned styles remain.
- Bounded stress and local differential privacy tests do not prove zero leaks on all sites or zero semantic errors. AI-labeled historical evaluation is development/regression evidence only; no new population-accuracy claim.
- Windows and macOS Chrome smoke tests were not available. Minimum Chrome 116 expresses required APIs, not proof that every Chrome version/device has been tested.
