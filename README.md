# ClearScroll

ClearScroll is an optional, local-first Chrome extension that blurs webpage text related to topics you choose. Text inference runs on your device. You can reveal an item, pause filtering or exclude a site at any time.

**0.4.0 is a local production candidate, not a published Chrome Web Store release.** See the exact release decision and artifact identity in `build/040-production-readiness/RELEASE-CANDIDATE.md`. GitHub main has not been synchronized or published by this work.

Filtering is best-effort: it can miss related text or hide unrelated text. ClearScroll is not a guaranteed spoiler blocker, parental-control security product, complete harmful-content protection system or perfect semantic classifier. English works best. Text may appear before it has been checked.

## Getting started

Install the verified unpacked candidate in a disposable Chrome profile using the release instructions. Settings opens on first installation. Add a topic in a few words, choose a mode and Save changes. No example topics are preconfigured. Start with Precise; Balanced is broader; Thorough may hide more unrelated text.

Click a blurred item, or focus it and press Enter or Space, to reveal it. A second click can follow a link. The toolbar popup lets you pause/resume or exclude the current site. Settings contains topic-specific literal exclusions and local feedback export/deletion. Help and privacy is available offline from both UI pages.

This package filters text. It omits experimental image classification and media downloads. A text match may still blur its whole card and thumbnail. YouTube video/Shorts filtering is unsupported because hover previews can escape the blur; new installs visibly exclude youtube.com and youtu.be. Removing those rules enables experimental behavior without reliable preview protection. Chrome pages, the Web Store, PDFs and embedded frames are unsupported.

## Privacy and documentation

No account, telemetry, external AI service or browsing-data upload is used. Settings and optional feedback stay in local extension storage. Exports can contain personal topic names; nothing is shared automatically.

- [Product scope](docs/production/PRODUCT-SCOPE.md)
- [Privacy policy](docs/production/PRIVACY-POLICY.md)
- [Support and troubleshooting](docs/production/SUPPORT.md)
- [Known limitations](docs/production/KNOWN-LIMITATIONS.md)
- [Permission justification](docs/production/PERMISSIONS-JUSTIFICATION.md)
- [Licenses and notices](docs/production/LICENSES-AND-NOTICES.md)
- [Release runbook](docs/production/RELEASE-RUNBOOK.md)
- [Rollback](docs/production/ROLLBACK.md)

## Development

Use the pinned Rust toolchain, exact wasm-bindgen version from Cargo.lock, Node22.18+ (release verification uses24.22.1), and npm ci. Prepare the pinned text model with npm run setup:model; no external model download occurs during normal extension use.

```
npm run check
npm run build
npm run validate
npm run test:dom
npm run test:e2e:text
```

The default build is text-focused. For reproducible assembly use `node scripts/assemble-production.mjs <new-output-directory>` and follow the evidence directory's REPRODUCE.md. The packager requires explicit unpacked/output paths; do not accidentally use a historical generic dist. GPU testing requires an actual nonfallback adapter, not only a successful software adapter probe.

The complete image-related source/tests and the [frozen0.3.5 developer guide](docs/PRIVATE-ALPHA-035-DEVELOPER-GUIDE.md) are retained for historical/private-alpha maintenance. `node scripts/build.mjs --with-images --out <separate-directory>` is developer comparison tooling, not the public package. Original all-image E2E/privacy tests are retained and run against frozen0.3.5; they are not text-release support claims. Existing development evaluation is not independent population accuracy evidence.

ClearScroll is ISC-licensed. Packaged model and dependency notices are included with the extension. No push, merge, public release or Web Store submission is part of the local build commands.
