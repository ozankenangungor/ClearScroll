/**
 * Media discovery for image filtering: which elements show a content image,
 * what image they show (its identity), and reading its pixels.
 *
 * Candidates: <img> (including <picture>, using the source the browser
 * actually selected: currentSrc), <video poster>, and elements whose content
 * is a single CSS background image (inline style or role="img"). Everything
 * else — favicons, icons, avatars, spacers, decorative backgrounds, page
 * backgrounds — is excluded by the size, shape and context rules below.
 *
 * Eligibility (all must hold):
 *   - rendered at least MIN_WIDTH × MIN_HEIGHT CSS px and MIN_AREA px²
 *     (small avatars and icons are skipped), aspect ratio ≤ MAX_ASPECT
 *     (banners, rules, spacers);
 *   - natural size at least MIN_NATURAL px on both sides;
 *   - not SVG (icons, logos, illustrations);
 *   - visible: pictures that are not laid out, hidden or fully transparent
 *     yet (lazy loading, fade-ins) are "pending" and re-checked; connected,
 *     not inside a protected area (navigation, header,
 *     footer, forms, buttons, editable regions, user selectors — the text
 *     list without `aria-hidden`, see compileProtectedSelector);
 *   - background images only: the element holds no text and no <img>, is not
 *     a page-level container, is not fixed-position and does not cover most
 *     of the viewport (a page or hero background is decoration, not a post).
 */

import { drawToRgb } from "../vision/preprocess.ts";

export const MEDIA_MIN_WIDTH = 100;
export const MEDIA_MIN_HEIGHT = 80;
export const MEDIA_MIN_AREA = MEDIA_MIN_WIDTH * MEDIA_MIN_HEIGHT;
export const MEDIA_MIN_NATURAL = 48;
export const MEDIA_MAX_ASPECT = 4.5;
/** Background elements covering more than this share of the viewport are page decoration. */
export const MEDIA_MAX_VIEWPORT_SHARE = 0.6;

export const MEDIA_SELECTOR = "img, video[poster], [style*='background'], [role='img']";

const CONTAINER_TAGS = new Set(["HTML", "BODY", "MAIN", "SECTION", "ARTICLE", "ASIDE", "NAV", "HEADER", "FOOTER", "FORM"]);

export type MediaKind = "img" | "poster" | "background";

export type MediaInfo =
  | { ok: true; kind: MediaKind; url: string; identity: string }
  | { ok: false; reason: "pending" | "ineligible" };

function isSvgUrl(url: string): boolean {
  if (/^data:image\/svg/i.test(url)) return true;
  try {
    return /\.svgz?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The single url(...) of a computed background-image, or null. */
export function backgroundUrl(value: string): string | null {
  if (!value || value === "none" || value.includes("gradient(")) return null;
  const urls = [...value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)];
  return urls.length === 1 ? urls[0]![2]! : null;
}

function sizeOk(r: DOMRect): boolean {
  if (r.width < MEDIA_MIN_WIDTH || r.height < MEDIA_MIN_HEIGHT || r.width * r.height < MEDIA_MIN_AREA) return false;
  return Math.max(r.width / r.height, r.height / r.width) <= MEDIA_MAX_ASPECT;
}

/** "hidden" (display/visibility), "transparent" (opacity 0) or "visible". */
function visibility(el: Element): "hidden" | "transparent" | "visible" {
  const check = (el as Element & { checkVisibility?(o: object): boolean }).checkVisibility;
  if (!check) return "visible";
  if (!check.call(el, { visibilityProperty: true })) return "hidden";
  return check.call(el, { opacityProperty: true }) ? "visible" : "transparent";
}

/** Is `el` a media element ClearScroll analyses, and which image does it show? */
export function mediaInfo(el: Element, protectedSelector: string): MediaInfo {
  const no = { ok: false, reason: "ineligible" } as const;
  if (!el.isConnected) return no;
  if (protectedSelector && el.closest(protectedSelector)) return no;
  if ((el as HTMLElement).isContentEditable) return no;
  const tag = el.tagName.toUpperCase();
  let kind: MediaKind;
  let url: string;
  if (tag === "IMG") {
    const img = el as HTMLImageElement;
    url = img.currentSrc || img.src;
    if (!url) return no;
    if (!img.complete || img.naturalWidth === 0) return img.complete ? no : { ok: false, reason: "pending" };
    if (img.naturalWidth < MEDIA_MIN_NATURAL || img.naturalHeight < MEDIA_MIN_NATURAL) return no;
    kind = "img";
  } else if (tag === "VIDEO") {
    url = (el as HTMLVideoElement).poster;
    if (!url) return no;
    kind = "poster";
  } else {
    if (CONTAINER_TAGS.has(tag) || el.querySelector("img, video, picture")) return no;
    if ((el.textContent ?? "").trim().length > 2) return no;
    const view = el.ownerDocument.defaultView!;
    const style = view.getComputedStyle(el);
    if (style.position === "fixed") return no;
    const bg = backgroundUrl(style.backgroundImage);
    if (!bg) return no;
    const r = el.getBoundingClientRect();
    if (r.width * r.height > MEDIA_MAX_VIEWPORT_SHARE * view.innerWidth * view.innerHeight) return no;
    try {
      url = new URL(bg, el.ownerDocument.baseURI).href;
    } catch {
      return no;
    }
    kind = "background";
  }
  if (isSvgUrl(url)) return no;
  // Not laid out yet, display:none / visibility:hidden or fully transparent
  // (lazy loaders and fade-ins, e.g. YouTube) can change without any event
  // the observers see: such pictures stay "pending" and are re-checked.
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0 || visibility(el) !== "visible") return { ok: false, reason: "pending" };
  if (!sizeOk(r)) return no;
  return { ok: true, kind, url, identity: `${kind}:${url}` };
}

/** Candidate media elements in `root` (including root itself). */
export function collectMedia(root: Node, out: Set<Element>): void {
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (el.matches(MEDIA_SELECTOR)) out.add(el);
  el.querySelectorAll(MEDIA_SELECTOR).forEach((m) => out.add(m));
}

/** URLs whose pixels the page itself can always expose (no network). */
export function isLocalImageUrl(url: string): boolean {
  return /^(data|blob):/i.test(url);
}

export class PixelsUnavailable extends Error {}

/**
 * Read the displayed image's pixels without any network request: draws the
 * already-decoded <img>, or decodes a data:/blob: URL. Cross-origin images
 * without CORS approval taint the canvas; that surfaces as PixelsUnavailable.
 */
export async function readPixels(el: Element, info: Extract<MediaInfo, { ok: true }>): Promise<Uint8Array> {
  let source: CanvasImageSource;
  if (info.kind === "img") {
    source = el as HTMLImageElement;
  } else if (isLocalImageUrl(info.url)) {
    const img = new Image();
    img.src = info.url;
    try {
      await img.decode();
    } catch {
      throw new PixelsUnavailable("image could not be decoded");
    }
    source = img;
  } else {
    throw new PixelsUnavailable("not readable in the page");
  }
  try {
    return drawToRgb(source);
  } catch (err) {
    if ((err as { name?: string }).name === "SecurityError") throw new PixelsUnavailable("cross-origin image");
    throw err;
  }
}
