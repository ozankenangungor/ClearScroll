/**
 * extractor.ts — Content Script (UI Thread)
 *
 * Observes DOM mutations, extracts text from newly added nodes,
 * batches them to the off-thread semantic worker, and blurs
 * matching content — all without blocking the main thread.
 */

const TAG = "[IdeaBlocker]";
const MIN_TEXT_LENGTH = 15;
const DEBOUNCE_MS = 150;
const STORAGE_KEY = "ideablocker_target";

// ── Types ──────────────────────────────────────────────────────────────

interface SetTargetRequest {
  type: "SET_TARGET";
  id: number;
  target: string;
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

type WorkerResponse = CompareResponse | { id: number; type: "SET_TARGET"; ok: true } | ErrorResponse;

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

let pendingTexts: string[] = [];
let pendingElements: HTMLElement[] = [];

const inflightRequests = new Map<number, HTMLElement[]>();

// ── Worker setup ───────────────────────────────────────────────────────

const workerURL = chrome.runtime.getURL("brain.worker.js");
const worker = new Worker(workerURL, { type: "module" });

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const msg = event.data;

  if ("error" in msg) {
    console.error(TAG, `Worker error (id=${msg.id}):`, msg.error);
    inflightRequests.delete(msg.id);
    return;
  }

  if (msg.type === "SET_TARGET") {
    console.log(TAG, "Target embedding set in worker.");
    return;
  }

  // COMPARE response
  const elements = inflightRequests.get(msg.id);
  inflightRequests.delete(msg.id);

  if (!elements) return;

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

// ── Send target to worker ──────────────────────────────────────────────

function sendTarget(target: string): void {
  const id = ++requestId;
  worker.postMessage({ type: "SET_TARGET", id, target } satisfies SetTargetRequest);
  console.log(TAG, `Sent target to worker: "${target}"`);
}

// Load target from storage on startup
chrome.storage.local.get([STORAGE_KEY], (result) => {
  const target = result[STORAGE_KEY];
  if (target && typeof target === "string" && target.trim().length > 0) {
    sendTarget(target);
  } else {
    console.log(TAG, "No block target set. Open extension options to configure.");
  }
});

// Listen for target changes (user updates from options page)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    const newTarget = String(changes[STORAGE_KEY].newValue || "");
    sendTarget(newTarget);

    // Clear analysis cache so existing text gets re-evaluated
    analyzedTexts.clear();

    // Remove blur from all previously blurred elements
    document.querySelectorAll<HTMLElement>('[style*="blur"]').forEach((el) => {
      el.style.filter = "";
      el.style.transition = "";
    });

    // Re-scan the page with the new target
    if (document.body) {
      extractTextsFromNode(document.body);
      if (pendingTexts.length > 0) {
        flushBatch();
      }
    }
  }
});

console.log(TAG, "Content script loaded. Worker spawned.");

// ── Text extraction ────────────────────────────────────────────────────

function extractTextsFromNode(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      const parent = node.parentElement;
      if (!parent || IGNORED_TAGS.has(parent.tagName)) {
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
    const text = textNode.data.trim();
    const parent = textNode.parentElement;

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

  inflightRequests.set(id, elements);

  worker.postMessage({ type: "COMPARE", id, texts } satisfies CompareRequest);

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
  extractTextsFromNode(document.body);
  if (pendingTexts.length > 0) {
    flushBatch();
  }

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  console.log(TAG, "MutationObserver active. Monitoring DOM.");
}

if (document.body) {
  start();
} else {
  document.addEventListener("DOMContentLoaded", start);
}
