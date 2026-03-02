/**
 * extractor.ts — Content Script (UI Thread)
 *
 * Observes DOM mutations, extracts text from newly added nodes,
 * batches them to the off-thread inference worker, and blurs
 * toxic content — all without blocking the main thread.
 */

const TAG = "[IdeaBlocker]";
const MIN_TEXT_LENGTH = 15;
const DEBOUNCE_MS = 150;

// ── Types ──────────────────────────────────────────────────────────────

interface ClassifyRequest {
  id: number;
  texts: string[];
}

interface ClassifyResponse {
  id: number;
  results: boolean[];
}

interface ErrorResponse {
  id: number;
  error: string;
}

type WorkerMessage = ClassifyResponse | ErrorResponse;

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

// ── State ──────────────────────────────────────────────────────────────

const analyzedTexts = new Set<string>();
let requestId = 0;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Pending batch: texts and their corresponding parent elements
let pendingTexts: string[] = [];
let pendingElements: HTMLElement[] = [];

// In-flight requests: id → element references for result mapping
const inflightRequests = new Map<number, HTMLElement[]>();

// ── Worker setup ───────────────────────────────────────────────────────

const workerURL = chrome.runtime.getURL("brain.worker.js");
const worker = new Worker(workerURL, { type: "module" });

worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  if ("error" in msg) {
    console.error(TAG, `Worker error (id=${msg.id}):`, msg.error);
    inflightRequests.delete(msg.id);
    return;
  }

  const elements = inflightRequests.get(msg.id);
  inflightRequests.delete(msg.id);

  if (!elements) return;

  // Apply blur to toxic elements inside rAF to avoid layout thrashing
  requestAnimationFrame(() => {
    for (let i = 0; i < msg.results.length; i++) {
      if (msg.results[i] && elements[i]) {
        const el = elements[i];
        el.style.filter = "blur(8px)";
        el.style.transition = "filter 0.3s ease";
      }
    }
  });
};

worker.onerror = (err) => {
  console.error(TAG, "Worker crashed:", err);
};

console.log(TAG, "Content script loaded. Worker spawned.");

// ── Text extraction ────────────────────────────────────────────────────

function extractTextsFromNode(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      // Skip nodes inside ignored elements
      const parent = node.parentElement;
      if (!parent || IGNORED_TAGS.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip tiny text fragments
      const text = node.data.trim();
      if (text.length < MIN_TEXT_LENGTH) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    const text = textNode.data.trim();
    const parent = textNode.parentElement;

    // Cache check — never send the same text twice
    if (analyzedTexts.has(text) || !parent) continue;

    analyzedTexts.add(text);
    pendingTexts.push(text);
    pendingElements.push(parent);
  }
}

// ── Flush batch to worker ──────────────────────────────────────────────

function flushBatch(): void {
  if (pendingTexts.length === 0) return;

  const id = ++requestId;
  const texts = pendingTexts;
  const elements = pendingElements;

  // Store element references for when results come back
  inflightRequests.set(id, elements);

  // Send only the string array to the worker (DOM refs stay on main thread)
  worker.postMessage({ id, texts } satisfies ClassifyRequest);

  // Reset pending batch
  pendingTexts = [];
  pendingElements = [];
}

// ── Debounced extraction trigger ───────────────────────────────────────

function scheduleFlush(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    flushBatch();
  }, DEBOUNCE_MS);
}

// ── MutationObserver ───────────────────────────────────────────────────

const observer = new MutationObserver((mutations: MutationRecord[]) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        // Added text node directly — extract from its parent context
        const text = (node as Text).data.trim();
        const parent = (node as Text).parentElement;
        if (
          text.length >= MIN_TEXT_LENGTH &&
          parent &&
          !IGNORED_TAGS.has(parent.tagName) &&
          !analyzedTexts.has(text)
        ) {
          analyzedTexts.add(text);
          pendingTexts.push(text);
          pendingElements.push(parent);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Element added — walk its subtree for text nodes
        const el = node as HTMLElement;
        if (!IGNORED_TAGS.has(el.tagName)) {
          extractTextsFromNode(el);
        }
      }
    }
  }

  if (pendingTexts.length > 0) {
    scheduleFlush();
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────

function start(): void {
  // Initial scan of existing page content
  extractTextsFromNode(document.body);
  if (pendingTexts.length > 0) {
    flushBatch();
  }

  // Watch for future DOM changes (infinite scroll, SPAs, etc.)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log(TAG, "MutationObserver active. Monitoring DOM.");
}

// Ensure body is available (content script runs at document_idle, so it should be)
if (document.body) {
  start();
} else {
  document.addEventListener("DOMContentLoaded", start);
}
