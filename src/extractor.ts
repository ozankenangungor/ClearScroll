/**
 * extractor.ts — Content Script (UI Thread)
 *
 * Precision-first extraction pipeline:
 * - site-level exclusions
 * - protected UI zones
 * - visibility/content quality gates
 * - chunked compare batches
 */

import {
  DEFAULT_SETTINGS,
  LEGACY_TARGET_KEY,
  SETTINGS_KEY,
  type IdeaBlockerSettings,
  isSiteExcluded,
  normalizeSettings,
} from "./settings";

const TAG = "[IdeaBlocker]";
const MIN_TEXT_LENGTH = 8;
const DEBOUNCE_MS = 150;
const BATCH_SIZE = 96;

// ── Types ──────────────────────────────────────────────────────────────

interface SetTargetRequest {
  type: "SET_TARGET";
  id: number;
  target: string;
}

interface SetConfigRequest {
  type: "SET_CONFIG";
  id: number;
  mode: IdeaBlockerSettings["mode"];
}

interface CompareRequest {
  type: "COMPARE";
  id: number;
  texts: string[];
}

interface CompareResponse {
  id: number;
  type: "COMPARE";
  results: boolean[];
}

interface ErrorResponse {
  id: number;
  error: string;
}

type WorkerResponse =
  | CompareResponse
  | { id: number; type: "SET_TARGET"; ok: true }
  | { id: number; type: "SET_CONFIG"; ok: true }
  | ErrorResponse;

// ── Ignored elements ───────────────────────────────────────────────────

const IGNORED_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "IFRAME",
  "SVG",
  "CODE",
  "PRE",
  "TEXTAREA",
  "INPUT",
]);

const DEFAULT_PROTECTED_SELECTORS = [
  "nav",
  "aside",
  "header",
  "footer",
  "form",
  "[role='navigation']",
  "[role='menu']",
  "[role='tablist']",
  "[role='toolbar']",
  "[contenteditable='true']",
  "[data-testid*='history']",
  "[aria-label*='history' i]",
  "[aria-label*='chat list' i]",
  "[aria-label*='sidebar' i]",
];

const IGNORED_CONTAINER_TAGS = new Set([
  "HTML",
  "BODY",
  "MAIN",
  "SECTION",
  "ARTICLE",
  "ASIDE",
  "NAV",
  "HEADER",
  "FOOTER",
]);

const BLUR_DATA_KEY = "ibBlurred";
const BLUR_SELECTOR = '[data-ib-blurred="1"]';

// ── State ──────────────────────────────────────────────────────────────

let settings: IdeaBlockerSettings = DEFAULT_SETTINGS;
let activeProtectedSelectors = [...DEFAULT_PROTECTED_SELECTORS];
let siteExcluded = false;

let worker: Worker | null = null;
let observer: MutationObserver | null = null;
let started = false;
let domStartHooked = false;

let analyzedByElement = new WeakMap<HTMLElement, string>();
let requestId = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

let pendingTexts: string[] = [];
let pendingElements: HTMLElement[] = [];

const inflightRequests = new Map<number, HTMLElement[]>();

// ── Utils ──────────────────────────────────────────────────────────────

function clearAllBlur(): void {
  document.querySelectorAll<HTMLElement>(BLUR_SELECTOR).forEach((el) => {
    clearBlur(el);
  });
}

function blurElement(el: HTMLElement): void {
  el.style.filter = "blur(8px)";
  el.style.transition = "filter 0.25s ease";
  el.dataset[BLUR_DATA_KEY] = "1";
}

function clearBlur(el: HTMLElement): void {
  if (el.dataset[BLUR_DATA_KEY] !== "1") return;
  el.style.filter = "";
  el.style.transition = "";
  delete el.dataset[BLUR_DATA_KEY];
}

function isVisibleElement(el: HTMLElement): boolean {
  if (!el.isConnected) return false;

  const withCheckVisibility = el as HTMLElement & {
    checkVisibility?: (options?: Record<string, unknown>) => boolean;
  };

  if (typeof withCheckVisibility.checkVisibility === "function") {
    try {
      if (
        !withCheckVisibility.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
          contentVisibilityAuto: true,
        })
      ) {
        return false;
      }
    } catch {
      // Fallback below.
    }
  }

  const style = window.getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;

  return true;
}

function isInProtectedZone(el: HTMLElement): boolean {
  for (const selector of activeProtectedSelectors) {
    try {
      if (el.closest(selector)) return true;
    } catch {
      // Ignore invalid custom selectors.
    }
  }
  return false;
}

function shouldAnalyzeElement(parent: HTMLElement, text: string): boolean {
  if (IGNORED_CONTAINER_TAGS.has(parent.tagName)) return false;
  if (isInProtectedZone(parent)) return false;
  if (!isVisibleElement(parent)) return false;

  // Skip very large containers where a small fragment would blur too much UI.
  const parentTextLen = (parent.textContent || "").trim().length;
  if (parentTextLen > 600 && text.length * 5 < parentTextLen) return false;

  // Skip highly nested UI containers for short snippets.
  if (parent.childElementCount > 8 && text.length < 80) return false;

  return true;
}

function queueForAnalysis(parent: HTMLElement, text: string): void {
  const clean = text.trim();
  if (clean.length < MIN_TEXT_LENGTH) return;
  if (!shouldAnalyzeElement(parent, clean)) return;

  const prev = analyzedByElement.get(parent);
  if (prev === clean) return;

  analyzedByElement.set(parent, clean);
  pendingTexts.push(clean);
  pendingElements.push(parent);
}

function resetAnalysisState(): void {
  analyzedByElement = new WeakMap<HTMLElement, string>();
  pendingTexts = [];
  pendingElements = [];
  inflightRequests.clear();

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// ── Worker setup ───────────────────────────────────────────────────────

function createInferenceWorker(): Worker {
  const extensionWorkerURL = chrome.runtime.getURL("brain.worker.js");

  try {
    return new Worker(extensionWorkerURL, { type: "module" });
  } catch (err) {
    // Some origins block direct chrome-extension:// worker construction.
    // Fallback: bootstrap from a same-origin blob that imports extension code.
    console.warn(TAG, "Direct worker init blocked, switching to blob bootstrap.", err);

    const bootstrap = `import ${JSON.stringify(extensionWorkerURL)};`;
    const blob = new Blob([bootstrap], { type: "text/javascript" });
    const blobURL = URL.createObjectURL(blob);
    const instance = new Worker(blobURL, { type: "module" });

    setTimeout(() => URL.revokeObjectURL(blobURL), 30_000);
    return instance;
  }
}

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = createInferenceWorker();

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data;

    if ("error" in msg) {
      console.error(TAG, `Worker error (id=${msg.id}):`, msg.error);
      inflightRequests.delete(msg.id);
      return;
    }

    if (msg.type !== "COMPARE") {
      return;
    }

    const elements = inflightRequests.get(msg.id);
    inflightRequests.delete(msg.id);
    if (!elements) return;

    requestAnimationFrame(() => {
      for (let i = 0; i < msg.results.length; i++) {
        const el = elements[i];
        if (!el) continue;

        if (msg.results[i]) {
          blurElement(el);
        } else {
          clearBlur(el);
        }
      }
    });
  };

  worker.onerror = (err) => {
    console.error(TAG, "Worker crashed:", err);
  };

  return worker;
}

function sendConfig(mode: IdeaBlockerSettings["mode"]): void {
  if (!worker) return;
  const id = ++requestId;
  worker.postMessage({ type: "SET_CONFIG", id, mode } satisfies SetConfigRequest);
}

function sendTarget(target: string): void {
  if (!worker) return;
  const id = ++requestId;
  worker.postMessage({ type: "SET_TARGET", id, target } satisfies SetTargetRequest);
}

// ── Text extraction ────────────────────────────────────────────────────

function extractTextsFromNode(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      const parent = node.parentElement;
      if (!parent || IGNORED_TAGS.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (isInProtectedZone(parent)) {
        return NodeFilter.FILTER_REJECT;
      }

      const text = node.data.trim();
      if (text.length < MIN_TEXT_LENGTH) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    const parent = textNode.parentElement;
    if (!parent) continue;
    queueForAnalysis(parent, textNode.data);
  }
}

// ── Flush batch to worker ──────────────────────────────────────────────

function flushBatch(): void {
  if (!worker || pendingTexts.length === 0) return;

  while (pendingTexts.length > 0) {
    const id = ++requestId;
    const texts = pendingTexts.splice(0, BATCH_SIZE);
    const elements = pendingElements.splice(0, BATCH_SIZE);

    inflightRequests.set(id, elements);
    worker.postMessage({ type: "COMPARE", id, texts } satisfies CompareRequest);
  }
}

function scheduleFlush(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushBatch();
  }, DEBOUNCE_MS);
}

// ── Observer ───────────────────────────────────────────────────────────

function setupObserver(): MutationObserver {
  return new MutationObserver((mutations: MutationRecord[]) => {
    if (!started || !worker) return;

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          const textNode = node as Text;
          const parent = textNode.parentElement;
          if (!parent || IGNORED_TAGS.has(parent.tagName)) continue;
          queueForAnalysis(parent, textNode.data);
          continue;
        }

        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (IGNORED_TAGS.has(el.tagName)) continue;
          if (isInProtectedZone(el)) continue;
          extractTextsFromNode(el);
        }
      }
    }

    if (pendingTexts.length > 0) {
      scheduleFlush();
    }
  });
}

// ── Lifecycle ──────────────────────────────────────────────────────────

function startFiltering(): void {
  if (started || siteExcluded || !document.body) return;

  const instance = ensureWorker();
  sendConfig(settings.mode);
  sendTarget(settings.target);

  extractTextsFromNode(document.body);
  if (pendingTexts.length > 0) {
    flushBatch();
  }

  observer = setupObserver();
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  started = true;
  void instance;
  console.log(TAG, "Filtering active.");
}

function stopFiltering(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (worker) {
    worker.terminate();
    worker = null;
  }

  started = false;
  resetAnalysisState();
  clearAllBlur();
}

function scheduleStart(): void {
  if (siteExcluded || started) return;

  if (document.body) {
    startFiltering();
    return;
  }

  if (domStartHooked) return;
  domStartHooked = true;
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      domStartHooked = false;
      if (!siteExcluded) {
        startFiltering();
      }
    },
    { once: true }
  );
}

function applySettings(nextSettings: IdeaBlockerSettings, rescan: boolean): void {
  settings = nextSettings;
  activeProtectedSelectors = Array.from(
    new Set([...DEFAULT_PROTECTED_SELECTORS, ...nextSettings.protectedSelectors])
  );

  if (nextSettings.target.trim().length === 0) {
    if (started || worker) {
      stopFiltering();
    }
    siteExcluded = false;
    console.log(TAG, "Filtering disabled (empty target).");
    return;
  }

  const shouldExclude = isSiteExcluded(window.location.href, nextSettings.excludedSites);
  if (shouldExclude) {
    siteExcluded = true;
    if (started || worker) {
      stopFiltering();
    }
    console.log(TAG, "Filtering disabled on this site by settings.");
    return;
  }

  siteExcluded = false;
  scheduleStart();

  if (!worker) return;

  sendConfig(nextSettings.mode);
  sendTarget(nextSettings.target);

  if (!rescan || !document.body) return;

  resetAnalysisState();
  clearAllBlur();
  extractTextsFromNode(document.body);
  if (pendingTexts.length > 0) {
    flushBatch();
  }
}

function loadSettings(callback: (settings: IdeaBlockerSettings) => void): void {
  chrome.storage.local.get([SETTINGS_KEY, LEGACY_TARGET_KEY], (result) => {
    callback(normalizeSettings(result[SETTINGS_KEY], result[LEGACY_TARGET_KEY]));
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────

console.log(TAG, "Content script loaded.");

loadSettings((initial) => {
  applySettings(initial, false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[SETTINGS_KEY] && !changes[LEGACY_TARGET_KEY]) return;

  loadSettings((next) => {
    applySettings(next, true);
  });
});
