# Privacy

ClearScroll hides web content about topics you choose. It is built so that
the text you read and the pictures you see never leave your computer.

## What ClearScroll processes

* **Text of web pages** (`http://` and `https://` pages only). The content
  script walks the page to find paragraph-sized pieces of text and sends the
  ones near the part of the page you are looking at to the on-device model.
  Input fields, editable areas, code blocks, navigation, forms, buttons and
  areas you mark as protected are skipped and never classified.
* **Pictures on web pages — only if you turn on *Images* (off by default).**
  Pictures near the part of the page you are looking at are scaled down to
  224 × 224 pixels in the page and these pixels are analysed by an on-device
  image model. Icons, avatars, SVG graphics, navigation, headers, forms,
  buttons, hidden pictures and protected areas are skipped.
* **Your settings:** topics, strictness, excluded sites, protected selectors,
  the engine preference and the two image options.

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

### Image filtering and network requests

| Settings | Network requests made by ClearScroll |
|---|---|
| Default (text only) | none |
| *Images* on | none — pictures are analysed from pixels the page already loaded; pictures whose pixels the browser does not expose to extensions (most pictures served from another domain) are left visible and counted in the popup |
| *Images* on **and** *Also check pictures from other domains* on | one request per such picture, to the address the page itself loaded it from |

The download option exists because browsers do not let an extension read the
pixels of a picture from another domain inside the page. When you enable it,
ClearScroll's offscreen document requests a copy of such a picture:

* only pictures shown on the page you are viewing, near the viewport, on a
  site you have not excluded, while a topic is active;
* **without cookies or other credentials and without a referrer** — the image
  server learns that someone fetched that picture, like a browser loading
  it, but not who you are logged in as or which page you were on;
* only `http`/`https` URLs of public hosts — never `localhost`, private,
  link-local or other special-purpose network addresses, `.local`/`.internal`
  names, or URLs with embedded credentials (`checkImageUrl`,
  `src/shared/vision.ts`);
* **redirects are never followed**: the request is made with
  `redirect: "manual"` and any redirect answer is treated as a failed
  download, so the extension never contacts an address it has not checked
  (pictures served through redirects are left unchecked);
* the check looks at the address as written, not at what its name resolves
  to: a public name that resolves to a private address (e.g. DNS rebinding)
  is not detected — browsers give extensions no way to see or pin the
  resolved address. Such a response is still fetched without cookies, only
  decoded as an image and reduced to "hidden / not hidden"; it is never
  passed back to the web page;
* image types only (JPEG, PNG, WebP, AVIF, GIF, BMP), at most 8 MiB and
  10 seconds per picture, decoded only in the extension's worker;
* the URL is re-checked by the service worker against your settings before
  any request; web pages cannot trigger downloads by messaging ClearScroll;
* **turning the option off takes effect at once**: downloads in progress are
  aborted, and requests approved a moment earlier are refused before they
  reach the network. The same happens when *Images* or filtering is turned
  off, the last topic is disabled, or a site is newly excluded. Pictures the
  page itself exposes keep being analysed from their pixels; the text engine
  is not restarted. Likewise, turning *Images* off cannot be undone by a
  request that was already under way: it is refused and the image model is
  not loaded again.

Picture pixels, their URLs, your topics and the results are never sent
anywhere. Picture URLs are not logged.

### How this is verified

`npm run verify:privacy` (also run in CI, on Chromium and on Google Chrome
stable) records every network request the browser makes while ClearScroll
filters three pages — with remote DNS disabled — and compares it with an
equally long control session with a no-op extension. It fails if any request
is initiated by an extension origin or if any external host is contacted only
in the ClearScroll session. Latest results: 0 requests from the extension on
both browsers; filtering worked offline. The browser itself contacts Google
services in both sessions (component updater, account check, autofill and,
in Chrome, the GCM check-in) — browser behaviour, unrelated to ClearScroll.

`npm run verify:privacy:images` repeats the capture with image filtering on
(a fourth page with photos, including two served from a second, "other-domain"
host): with downloads off it requires the same zero requests and that a
picture is hidden offline from its pixels; with downloads on it allows
exactly one cookie-less request for each of the two displayed other-domain
pictures and fails on any other request (`scripts/verify-no-egress.ts`).
Latest results (Chromium): 0 extension requests with images on; exactly the
two expected picture requests, without cookies, with downloads on.

## What is stored

In `chrome.storage.local` on this device (not synced):

* `clearscroll_settings` — your topics, strictness, site rules, protected
  selectors and engine preference;
* `clearscroll_migration_notes` — only if old IdeaBlocker site rules could
  not be converted: the rejected rule texts, until you dismiss the notice.

In the extension's own IndexedDB (database `clearscroll-vision`, only when
image filtering is used): for each topic you entered, its text and the 768
numbers the image model computed from it, so the image text encoder does not
have to be loaded again in a later session. Nothing from web pages is
stored there; at most 128 topics (least recently used are removed); removed
with the extension.

In `chrome.storage.session` (memory only, cleared when the browser closes):
`clearscroll_registration_error`, the last Chrome error message from
registering the content script, if any — no page or browsing data.

Classification results are kept in memory only — an in-memory cache of text
embeddings in the offscreen document (at most 4,000 entries), of picture
embeddings (at most 1,000, keyed by picture URL or a hash of its pixels; not
the pictures themselves) and topic embeddings, and per-element state in each
tab — and disappear when the tab closes, when filtering or image filtering is
turned off or when the browser restarts. They are never written to disk.
Downloaded picture copies exist only while being decoded.

**Copy diagnostics** (Settings → Advanced → Diagnostics) builds a short text
summary only when you click the button and puts it on the clipboard for you
to paste into a bug report yourself: extension and Chrome major version,
on/off switches, strictness, the number of topics, excluded sites and
protected areas, and the status of the text and image models. It contains
no page content, no web addresses and no site rules; topic names only if
you tick *Include my topic names*. It is not stored or sent anywhere.

## Permissions and why they are needed

| Permission | Why |
|---|---|
| Access to `http://*/*` and `https://*/*` | To read and blur text (and, if enabled, pictures) on the pages you visit. ClearScroll only runs while at least one topic is active and never on sites you exclude. With *Also check pictures from other domains* on, the same host access lets the extension download those pictures (see above). |
| `scripting` | To register the content script while filtering is active (and unregister it otherwise) and to start filtering in tabs that were already open. |
| `storage` | To save your settings locally. |
| `offscreen` | To run the AI models in a hidden extension page, isolated from websites' security policies and shared by all tabs. |

No `tabs`, `history`, `cookies`, `webRequest` or `identity` permission is
requested.

## Turning it off or removing it

* **Pause:** toolbar popup → untick *Filtering enabled*. All blur is removed
  immediately, the content script is unregistered and the models are unloaded.
* **Images only:** Settings → Images → untick *Also hide pictures…*. Picture
  blur is removed at once and the image model is unloaded; text filtering
  continues.
* **One site:** popup → *Never run on this site*, or edit the site list in
  Settings.
* **Remove:** `chrome://extensions` → ClearScroll → *Remove*. Chrome deletes
  the extension and its stored settings.

## Contact

Questions or concerns: open an issue at
<https://github.com/ozankenangungor/ClearScroll/issues>.
