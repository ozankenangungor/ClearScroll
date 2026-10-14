# Privacy

ClearScroll hides web content about topics you choose. It is built so that
the text you read never leaves your computer.

## What ClearScroll processes

* **Text of web pages** (`http://` and `https://` pages only). The content
  script walks the page to find paragraph-sized pieces of text and sends the
  ones near the part of the page you are looking at to the on-device model.
  Input fields, editable areas, code blocks, navigation, forms, buttons and
  areas you mark as protected are skipped and never classified.
* **Your settings:** topics, strictness, excluded sites, protected selectors
  and the engine preference.

## Where processing happens

Entirely on your device. Page text is passed from the content script to the
extension's own background service worker and offscreen document via
Chrome's internal extension messaging, and is classified by an AI model that
ships inside the extension package and runs in a Web Worker
(WebAssembly, using your GPU through WebGPU when available).

* No page text, topic, URL or browsing history is sent anywhere.
* There is no server, no account, no analytics and no telemetry.
* The model is **not downloaded at run time**: it is part of the installed
  extension. (Developers building from source download it once from
  Hugging Face at build time; see `docs/MODEL.md`.)
* The extension declares no `web_accessible_resources`, so websites cannot
  detect it by probing its files.

### How this is verified

`npm run verify:privacy` (also run in CI) records every network request
Chromium makes while ClearScroll filters three pages — with remote DNS
disabled — and compares it with the same session without the extension. It
fails if any request is initiated by the extension or if any external host is
contacted only when the extension is loaded. Latest result: 0 requests from
the extension; filtering worked offline. (Chromium itself contacts Google
services such as its component updater in both runs; that is browser
behaviour, unrelated to ClearScroll.)

## What is stored

Only your settings, in `chrome.storage.local` on this device (not synced).
Classification results are kept in memory only — an in-memory cache of text
embeddings in the offscreen document (at most 4,000 entries) and per-element
state in each tab — and disappear when the tab closes, when filtering is
turned off or when the browser restarts. Nothing is written to disk.

## Permissions and why they are needed

| Permission | Why |
|---|---|
| Access to `http://*/*` and `https://*/*` | To read and blur text on the pages you visit. ClearScroll only runs while at least one topic is active and never on sites you exclude. |
| `scripting` | To register the content script while filtering is active (and unregister it otherwise) and to start filtering in tabs that were already open. |
| `storage` | To save your settings locally. |
| `offscreen` | To run the AI model in a hidden extension page, isolated from websites' security policies and shared by all tabs. |

No `tabs`, `history`, `cookies`, `webRequest` or `identity` permission is
requested.

## Turning it off or removing it

* **Pause:** toolbar popup → untick *Filtering enabled*. All blur is removed
  immediately, the content script is unregistered and the model is unloaded.
* **One site:** popup → *Never run on this site*, or edit the site list in
  Settings.
* **Remove:** `chrome://extensions` → ClearScroll → *Remove*. Chrome deletes
  the extension and its stored settings.

## Contact

Questions or concerns: open an issue at
<https://github.com/ozankenangungor/ClearScroll/issues>.
