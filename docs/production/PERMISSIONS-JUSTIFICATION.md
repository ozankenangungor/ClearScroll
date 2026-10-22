# Permissions and reviewer instructions

| Permission | User-facing need |
| --- | --- |
| storage | Local topics, exclusions, preferences and optional feedback; session operational state. No Sync service. |
| scripting | Register/update content scripts only with active topics, exclude configured sites, and activate filtering in already-open tabs. |
| offscreen | Host one shared local inference worker outside arbitrary site CSP, preserving service worker lifecycle and avoiding one model per tab. |
| http://*/* and https://*/* | User-selected topic filtering automatically on arbitrary ordinary websites, including navigation and already-open tabs. |

No tabs, history, cookies, webRequest, downloads, clipboardRead, management or unlimitedStorage permission is requested. Host access permits reading tab URLs for site exclusions and scripting; no separate tabs permission is needed. No web-accessible resources, external messaging, remote scripts or external inference endpoints are declared.

The current two wildcard host patterns cover all HTTP/HTTPS hosts. Per-site optional access would cover zero hosts before consent and then only N granted domains; activeTab would require a fresh activation gesture instead of automatic coverage. Broad host access remains a sensitive permission and produces Chrome's all-sites warning. activeTab alone would require a gesture per tab and would break automatic navigation. Optional per-site host grants would reduce ambient access but require a new permission-grant UI, registration reconciliation on grant/revocation and migration/lifecycle QA; it is an architectural change, not a manifest-only removal. Benefit: processing limited to explicitly granted sites. Risk: silently inactive filtering, broken existing open-tab behavior and inconsistent exclusions. This release keeps the smallest permission set for its existing automatic arbitrary-site feature and adds none. Chrome's own site-access controls can restrict access; reload after granting it. An exclusion is a processing rule, not revocation of Chrome host permission.

Review using an empty profile: Settings opens on install, with no topics and visible YouTube exclusions. Add “cryptocurrency”, Save changes, then visit the provided synthetic production fixture or an ordinary text page. Confirm status reports model loading/CPU/WebGPU/keyword fallback correctly, reveal and pause work, and feedback export stays local. Packaged WASM, weights and vocabulary require no internet. Image/download controls and image models are absent from the text package. Source map-free minification is for size; all readable source and exact locks are available in the local source snapshot.
