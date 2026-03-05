/**
 * brain.worker.ts — Off-thread semantic inference worker
 *
 * Runs the Burn/WebGPU WASM embedder in a dedicated worker thread.
 * Supports two message types:
 *   - SET_TARGET: embed a user prompt and store the reference vector
 *   - COMPARE:    compare incoming texts against the reference vector
 */

import { type FilterMode } from "./settings";

export {}; // Force TypeScript to treat this as a module

const TAG = "[IdeaBlocker/Worker]";

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

interface SetConfigRequest {
  type: "SET_CONFIG";
  id: number;
  mode: FilterMode;
}

type WorkerRequest = SetTargetRequest | CompareRequest | SetConfigRequest;

interface SetTargetResponse {
  id: number;
  type: "SET_TARGET";
  ok: true;
}

interface SetConfigResponse {
  id: number;
  type: "SET_CONFIG";
  ok: true;
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

// ── State ──────────────────────────────────────────────────────────────

let wasmModule: {
  init: () => Promise<void>;
  embed_text: (text: string) => Promise<Float32Array>;
  compare_batch: (
    reference: Float32Array,
    texts: string[],
    threshold: number
  ) => Promise<unknown[]>;
} | null = null;

let ready = false;
let semanticAvailable = false;
let referenceEmbedding: Float32Array | null = null;
let normalizedTarget = "";
let targetTokens: string[] = [];
let targetPhraseRegex: RegExp | null = null;
let mode: FilterMode = "precision";

const MODE_PARAMS: Record<
  FilterMode,
  {
    similarityThreshold: number;
    minTokenLen: number;
    minSemanticTextLen: number;
    minMultiTokenMatch: number;
    multiTokenMatchRatio: number;
  }
> = {
  precision: {
    similarityThreshold: 0.68,
    minTokenLen: 6,
    minSemanticTextLen: 30,
    minMultiTokenMatch: 2,
    multiTokenMatchRatio: 0.75,
  },
  balanced: {
    similarityThreshold: 0.62,
    minTokenLen: 5,
    minSemanticTextLen: 24,
    minMultiTokenMatch: 2,
    multiTokenMatchRatio: 0.6,
  },
  aggressive: {
    similarityThreshold: 0.56,
    minTokenLen: 4,
    minSemanticTextLen: 16,
    minMultiTokenMatch: 1,
    multiTokenMatchRatio: 0.5,
  },
};

const pendingQueue: WorkerRequest[] = [];

function normalizeText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTargetPhraseRegex(target: string): RegExp | null {
  if (!target) return null;
  const escaped = escapeRegex(target).replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "u");
}

function tokenizeWords(input: string, minTokenLen: number): string[] {
  const parts = normalizeText(input)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((part) => part.length >= minTokenLen);
  return Array.from(new Set(parts));
}

function currentParams() {
  return MODE_PARAMS[mode];
}

function applyTarget(target: string): void {
  normalizedTarget = normalizeText(target);
  targetTokens = tokenizeWords(normalizedTarget, currentParams().minTokenLen);
  targetPhraseRegex = buildTargetPhraseRegex(normalizedTarget);
}

function applyMode(nextMode: FilterMode): void {
  mode = nextMode in MODE_PARAMS ? nextMode : "precision";

  // Token rules depend on mode; re-tokenize current target.
  if (normalizedTarget) {
    targetTokens = tokenizeWords(normalizedTarget, currentParams().minTokenLen);
    targetPhraseRegex = buildTargetPhraseRegex(normalizedTarget);
  }
}

function tokenizeText(input: string): Set<string> {
  return new Set(tokenizeWords(input, currentParams().minTokenLen));
}

function lexicalMatch(text: string): boolean {
  if (!normalizedTarget) return false;

  const normalized = normalizeText(text);
  if (targetPhraseRegex && targetPhraseRegex.test(normalized)) {
    return true;
  }

  if (targetTokens.length === 0) return false;

  const words = tokenizeText(normalized);
  if (targetTokens.length === 1) {
    return words.has(targetTokens[0]);
  }

  let matchCount = 0;
  for (const token of targetTokens) {
    if (words.has(token)) matchCount++;
  }

  const required = Math.max(
    currentParams().minMultiTokenMatch,
    Math.ceil(targetTokens.length * currentParams().multiTokenMatchRatio)
  );
  return matchCount >= required;
}

// ── Init ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  console.log(TAG, "Initializing...");

  try {
    // Always resolve runtime assets from the extension module URL itself.
    // This avoids inheriting page/blob origins under strict site CSP.
    const baseURL = new URL("./", import.meta.url).href;
    const wasmJsURL = baseURL + "pkg/text_classifier_wasm.js";

    const wasm = await import(/* @vite-ignore */ wasmJsURL);
    await wasm.default();
    await wasm.init();

    wasmModule = {
      init: wasm.init,
      embed_text: wasm.embed_text,
      compare_batch: wasm.compare_batch,
    };

    semanticAvailable = true;
    ready = true;
    console.log(TAG, "WASM init complete. Semantic embedder ready.");

    void drainQueue();
  } catch (err) {
    // Graceful degradation: keep lexical filtering active even if semantic engine fails.
    semanticAvailable = false;
    wasmModule = null;
    ready = true;
    console.error(TAG, "WASM init failed. Falling back to lexical-only mode.", err);
    void drainQueue();
  }
}

// ── Queue drain ────────────────────────────────────────────────────────

async function drainQueue(): Promise<void> {
  while (pendingQueue.length > 0) {
    const req = pendingQueue.shift()!;
    await processRequest(req);
  }
}

// ── Request processing ─────────────────────────────────────────────────

async function processRequest(req: WorkerRequest): Promise<void> {
  try {
    if (req.type === "SET_CONFIG") {
      applyMode(req.mode);
      self.postMessage({ id: req.id, type: "SET_CONFIG", ok: true } satisfies SetConfigResponse);
      return;
    }

    if (req.type === "SET_TARGET") {
      if (req.target.trim().length === 0) {
        // Empty target clears the filter
        referenceEmbedding = null;
        normalizedTarget = "";
        targetTokens = [];
        targetPhraseRegex = null;
        console.log(TAG, "Target cleared — filtering disabled.");
      } else {
        applyTarget(req.target);
        if (semanticAvailable && wasmModule) {
          referenceEmbedding = await wasmModule.embed_text(req.target);
          console.log(TAG, `Target set: "${req.target}" → embedding[${referenceEmbedding.length}]`);
        } else {
          referenceEmbedding = null;
          console.log(TAG, `Target set: "${req.target}" (lexical-only mode).`);
        }
      }
      self.postMessage({ id: req.id, type: "SET_TARGET", ok: true } satisfies SetTargetResponse);
    } else if (req.type === "COMPARE") {
      if (!normalizedTarget) {
        // No target set — nothing should be blocked
        const results = new Array<boolean>(req.texts.length).fill(false);
        self.postMessage({ id: req.id, type: "COMPARE", results } satisfies CompareResponse);
        return;
      }

      if (!semanticAvailable || !wasmModule || !referenceEmbedding) {
        const results = req.texts.map((text) => lexicalMatch(text || ""));
        self.postMessage({ id: req.id, type: "COMPARE", results } satisfies CompareResponse);
        return;
      }

      const semanticRaw = await wasmModule.compare_batch(
        referenceEmbedding,
        req.texts,
        currentParams().similarityThreshold
      );
      const semanticResults = Array.from(semanticRaw, (v, i) => {
        if (!Boolean(v)) return false;
        return (req.texts[i] || "").trim().length >= currentParams().minSemanticTextLen;
      });
      const results = semanticResults.map((isSemanticMatch, i) => {
        if (isSemanticMatch) return true;
        return lexicalMatch(req.texts[i] || "");
      });
      self.postMessage({ id: req.id, type: "COMPARE", results } satisfies CompareResponse);
    }
  } catch (err) {
    if (req.type === "COMPARE") {
      // Runtime semantic failure after successful init (GPU reset, adapter issue, etc.)
      // Switch to lexical mode to keep UX functional.
      semanticAvailable = false;
    }
    console.error(TAG, `Error processing ${req.type} (id=${req.id}):`, err);
    self.postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ErrorResponse);
  }
}

// ── Message handler ────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;

  if (!ready) {
    pendingQueue.push(req);
    return;
  }

  void processRequest(req);
};

// ── Kick off initialization immediately ────────────────────────────────
bootstrap();
