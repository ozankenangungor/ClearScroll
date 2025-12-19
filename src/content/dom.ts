/**
 * DOM helpers for the content script: which elements are classified ("units")
 * and how their visual state is changed.
 *
 * Units: text is attributed to its nearest non-inline ancestor (a <p>, <li>,
 * <h2>, a tweet's text <div>, …), so the spans/links inside one paragraph are
 * classified together and cannot produce conflicting verdicts. Elements that
 * contain block-level descendants are containers, not units, and are never
 * blurred as a whole.
 *
 * Visual state is expressed only through extension-owned attributes styled by
 * content.css. Page inline styles, classes, listeners and child nodes are
 * never modified; the only other attributes touched (tabindex, title) are
 * added solely when absent and are removed again on unblur, which makes every
 * operation reversible and idempotent.
 */

export const STATE_ATTR = "data-clearscroll";
/** Which controller instance applied the state (see clearAllVisuals). */
export const OWNER_ATTR = "data-clearscroll-owner";
const ADDED_TABINDEX_ATTR = "data-clearscroll-tabindex";
const ADDED_TITLE_ATTR = "data-clearscroll-title";
export const REVEAL_HINT = "Hidden by ClearScroll — click or press Enter to reveal";

export const MIN_TEXT_CHARS = 8;
export const MAX_UNIT_CHARS = 5000;
export const MAX_SENT_CHARS = 1000;

const INLINE_TAGS = new Set([
  "A", "ABBR", "B", "BDI", "BDO", "CITE", "DATA", "DEL", "DFN", "EM", "FONT", "I", "INS",
  "KBD", "MARK", "Q", "RUBY", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME",
  "U", "VAR", "WBR", "BR",
]);

/** Subtrees that are never analysed: non-content or user-input elements. */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "CANVAS", "SVG",
  "MATH", "VIDEO", "AUDIO", "CODE", "PRE", "KBD", "SAMP", "TEXTAREA", "INPUT", "SELECT",
  "OPTION", "BUTTON", "HEAD", "TITLE",
]);

/** Never treat these as a unit (blurring them would hide the whole page). */
const CONTAINER_TAGS = new Set(["HTML", "BODY", "MAIN", "SECTION", "ARTICLE", "ASIDE", "NAV", "HEADER", "FOOTER", "FORM"]);

const BLOCK_DESCENDANTS =
  "p,div,li,ul,ol,dl,table,section,article,aside,nav,header,footer,main,form,h1,h2,h3,h4,h5,h6,blockquote,pre,figure,fieldset,details,hr";

export const DEFAULT_PROTECTED_SELECTORS = [
  "nav",
  "aside",
  "body > header",
  "body > footer",
  "form",
  "button",
  "[role='button']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='search']",
  "[role='menu']",
  "[role='menubar']",
  "[role='tablist']",
  "[role='toolbar']",
  "[role='listbox']",
  "[role='combobox']",
  "[role='dialog'][aria-modal='true']",
  "[contenteditable]:not([contenteditable='false'])",
  "[aria-hidden='true']",
];

/** Combine selectors into one string, dropping any that do not parse. */
export function compileProtectedSelector(custom: readonly string[], doc: Document = document): string {
  const valid: string[] = [];
  for (const sel of [...DEFAULT_PROTECTED_SELECTORS, ...custom]) {
    try {
      doc.createDocumentFragment().querySelector(sel);
      valid.push(sel);
    } catch {
      /* invalid custom selector: ignored here, reported by the options page */
    }
  }
  return valid.join(",");
}

export function isSkippedSubtree(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName.toUpperCase());
}

/** Nearest non-inline ancestor of a text node or element. */
export function unitOf(node: Node): Element | null {
  let el: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  while (el && INLINE_TAGS.has(el.tagName.toUpperCase()) && el.parentElement) {
    el = el.parentElement;
  }
  return el;
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Returns the unit's text if it should be classified, or null with no side
 * effects. `protectedSelector` comes from compileProtectedSelector().
 */
export function unitText(unit: Element, protectedSelector: string): string | null {
  const tag = unit.tagName.toUpperCase();
  if (CONTAINER_TAGS.has(tag) || SKIP_TAGS.has(tag)) return null;
  if (!unit.isConnected) return null;
  if (protectedSelector && unit.closest(protectedSelector)) return null;
  for (let p: Element | null = unit; p; p = p.parentElement) {
    if (SKIP_TAGS.has(p.tagName.toUpperCase())) return null;
  }
  if ((unit as HTMLElement).isContentEditable) return null;
  if (unit.querySelector(BLOCK_DESCENDANTS)) return null;
  const text = normalizeText(unit.textContent ?? "");
  if (text.length < MIN_TEXT_CHARS || text.length > MAX_UNIT_CHARS) return null;
  return text.slice(0, MAX_SENT_CHARS);
}

/** All candidate units below `root` (including root itself). */
export function collectUnits(root: Node, protectedSelector: string, out: Set<Element>): void {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as Element;
        if (isSkippedSubtree(el) || el.hasAttribute("hidden")) return NodeFilter.FILTER_REJECT;
        if (protectedSelector && el.matches(protectedSelector)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
      return (node as Text).data.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const u = unitOf(n);
    if (u) out.add(u);
  }
}

// ── Visual state ───────────────────────────────────────────────────────────

export type VisualState = "blurred" | "revealed" | null;

export function visualState(el: Element): VisualState {
  const v = el.getAttribute(STATE_ATTR);
  return v === "blurred" || v === "revealed" ? v : null;
}

function isNativelyFocusable(el: Element): boolean {
  return el.hasAttribute("tabindex") || /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName.toUpperCase());
}

export function applyBlur(el: Element, owner: string): void {
  el.setAttribute(OWNER_ATTR, owner);
  if (visualState(el) === "blurred") return;
  el.setAttribute(STATE_ATTR, "blurred");
  if (!isNativelyFocusable(el)) {
    el.setAttribute("tabindex", "0");
    el.setAttribute(ADDED_TABINDEX_ATTR, "");
  }
  if (!el.hasAttribute("title")) {
    el.setAttribute("title", REVEAL_HINT);
    el.setAttribute(ADDED_TITLE_ATTR, "");
  }
}

/** Remove only what we added; leaves the element exactly as the page had it. */
function removeAdditions(el: Element): void {
  if (el.hasAttribute(ADDED_TABINDEX_ATTR)) {
    el.removeAttribute("tabindex");
    el.removeAttribute(ADDED_TABINDEX_ATTR);
  }
  if (el.hasAttribute(ADDED_TITLE_ATTR)) {
    if (el.getAttribute("title") === REVEAL_HINT) el.removeAttribute("title");
    el.removeAttribute(ADDED_TITLE_ATTR);
  }
}

export function markRevealed(el: Element, owner: string): void {
  removeAdditions(el);
  el.setAttribute(STATE_ATTR, "revealed");
  el.setAttribute(OWNER_ATTR, owner);
}

export function clearVisual(el: Element): void {
  removeAdditions(el);
  el.removeAttribute(STATE_ATTR);
  el.removeAttribute(OWNER_ATTR);
}

/**
 * Remove the visual state applied by `owner`. Scoped by owner because after
 * an extension update the orphaned old content script and the newly injected
 * one share the page: the old one tearing down must not undo the new one.
 */
export function clearAllVisuals(doc: Document, owner: string): void {
  doc.querySelectorAll(`[${OWNER_ATTR}="${CSS.escape(owner)}"]`).forEach(clearVisual);
}
