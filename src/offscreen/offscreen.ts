/**
 * offscreen.ts — extension-origin document that hosts the inference worker.
 *
 * Why an offscreen document: content scripts cannot construct workers from
 * chrome-extension:// URLs, and page-origin (blob:) workers are subject to
 * the page's CSP, which on many sites forbids blob workers or WebAssembly.
 * This document runs under the extension's own CSP, and one engine instance
 * is shared by every tab instead of loading the model once per tab.
 *
 * It hosts two independent engines: EngineHost (Rust text encoder) and
 * VisionHost (image model, loaded only when image filtering needs it).
 *
 * Query parameters (set by the background script):
 *   backend=auto|cpu|off      inference backend preference from settings
 *   allowFallbackAdapter=1    test-only: also try software WebGPU adapters
 */

import { EngineHost, type ModelMeta } from "./engine-host.ts";
import { VisionHost } from "./vision-host.ts";
import { isOffscreenMessage, type Backend, type OffscreenStatusChanged } from "../shared/protocol.ts";
import { isOffscreenVisionMessage, type VisionStatusChanged } from "../shared/vision.ts";

const TAG = "[ClearScroll/offscreen]";
const params = new URLSearchParams(location.search);
const preference = params.get("backend") ?? "auto";
const allowFallbackAdapter = params.get("allowFallbackAdapter") === "1";

interface AdapterLike {
  info?: { isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
}

/** Why WebGPU was not offered (surfaced in the engine status detail). */
let webgpuSkipReason: string | null = null;

async function availableBackends(): Promise<Backend[]> {
  if (preference === "off") return [];
  if (preference === "cpu") return ["cpu"];
  const out: Backend[] = [];
  try {
    // The wgpu runtime aborts the WASM instance if no adapter exists, so we
    // probe here and only offer WebGPU when an adapter is actually available.
    // Software adapters (SwiftShader) emulate the GPU on the CPU: slower than
    // the WASM CPU backend and, in our tests, numerically broken.
    // Same preference the engine's wgpu runtime requests (cubecl-wgpu uses
    // HighPerformance), so we probe the adapter that will actually be used.
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o: { powerPreference: string }): Promise<AdapterLike | null> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter({ powerPreference: "high-performance" }) : null;
    const fallback = adapter?.info?.isFallbackAdapter ?? adapter?.isFallbackAdapter ?? false;
    if (adapter && (!fallback || allowFallbackAdapter)) out.push("webgpu");
    else webgpuSkipReason = !gpu ? "WebGPU API unavailable" : !adapter ? "no WebGPU adapter" : "only a software (fallback) WebGPU adapter";
  } catch (err) {
    webgpuSkipReason = `WebGPU probe failed: ${String(err)}`;
  }
  out.push("cpu");
  return out;
}

const host = new EngineHost({
  createWorker: () => new Worker(new URL("engine.worker.js", location.href), { type: "module" }),
  assetUrl: (path) => new URL(path, location.href).href,
  backends: availableBackends,
  backendNote: () => webgpuSkipReason,
  loadModelMeta: async () => {
    const res = await fetch(new URL("model/model.json", location.href));
    if (!res.ok) throw new Error(`model/model.json: HTTP ${res.status}`);
    const meta = (await res.json()) as Partial<ModelMeta>;
    if (typeof meta.id !== "string" || !meta.selftest) throw new Error("model/model.json is incomplete");
    return meta as ModelMeta;
  },
  onStatus: (status) => {
    console.info(TAG, "engine:", status.state, status.backend ?? "", status.detail ?? "");
    const msg: OffscreenStatusChanged = { type: "off:status-changed", status };
    chrome.runtime.sendMessage(msg).catch(() => {
      /* background may be asleep; it re-queries status on demand */
    });
  },
  now: () => Date.now(),
});

// Half the logical cores, at most 4: measured 564 → 166 ms per image with 4
// threads (docs/BENCHMARKS.md), no gain beyond; leaves cores for the page and
// the text engine. Used only where the worker is cross-origin isolated.
const MODEL_THREADS = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));

const vision = new VisionHost({
  createWorker: () => new Worker(new URL("vision.worker.js", location.href), { type: "module" }),
  threads: MODEL_THREADS,
  // The text encoder is short-lived; threads shorten the first-picture path.
  textThreads: MODEL_THREADS,
  assetUrl: (path) => new URL(path, location.href).href,
  // Bound: the host calls fetch as a free function.
  fetch: (input, init) => fetch(input, init),
  onStatus: (status) => {
    console.info(TAG, "vision:", status.state, status.detail ?? "");
    const msg: VisionStatusChanged = { type: "off:vision-status-changed", status };
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  },
  now: () => Date.now(),
  loadBackground: async () => {
    const res = await fetch(new URL("vision/background.json", location.href));
    return res.ok ? res.json() : null;
  },
  sha256: async (data) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  },
});

// Exposed for the benchmark harness and debugging from DevTools.
(globalThis as Record<string, unknown>).clearscrollEngine = host;
(globalThis as Record<string, unknown>).clearscrollVision = vision;

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (isOffscreenVisionMessage(msg)) {
    if (msg.type === "off:vision") {
      void vision.classify(msg).then(sendResponse);
      return true;
    }
    if (msg.type === "off:vision-shutdown") vision.shutdown(msg.revokedAt);
    if (msg.type === "off:vision-revoke-downloads") vision.revokeDownloads(msg.revokedAt);
    sendResponse(msg.type === "off:vision-stats" ? { ...vision.stats, skipped: { ...vision.stats.skipped } } : vision.getStatus());
    return false;
  }
  if (!isOffscreenMessage(msg)) return false;
  if (msg.type === "off:status") {
    sendResponse(host.getStatus());
    return false;
  }
  if (msg.type === "off:stats") {
    sendResponse({ ...host.stats });
    return false;
  }
  void host.classify(msg).then(sendResponse);
  return true;
});
