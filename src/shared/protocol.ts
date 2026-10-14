/**
 * Message protocol between extension contexts.
 *
 *   content script ──cs:classify──▶ background ──off:classify──▶ offscreen ──embed──▶ engine worker
 *   popup/options ──ui:status────▶ background
 *   popup         ──tab:state────▶ content script (chrome.tabs.sendMessage)
 *
 * Every request carries an immutable snapshot of the configuration it was
 * computed for (topics + mode + generation). Nothing in the pipeline holds
 * mutable "current target" state, so results can never mix configurations;
 * the content script additionally discards replies whose generation is no
 * longer current.
 */

import type { Decision } from "./classifier.ts";
import { FILTER_MODES, LIMITS, type FilterMode } from "./settings.ts";

export const LIMITS_PROTOCOL = {
  maxTextsPerRequest: 64,
  maxTextChars: 2000,
} as const;

export type EngineState = "idle" | "loading" | "semantic" | "lexical-fallback" | "error";
export type Backend = "webgpu" | "cpu";

export interface EngineStatus {
  state: EngineState;
  backend: Backend | null;
  model: string;
  /** Human-readable detail for diagnostics (never shown as the primary status). */
  detail: string | null;
  loadMs: number | null;
  updatedAt: number;
}

export interface TopicSnapshot {
  id: string;
  text: string;
}

export interface ClassifyRequest {
  type: "cs:classify";
  generation: number;
  mode: FilterMode;
  topics: TopicSnapshot[];
  texts: string[];
}

export type ClassifyReply =
  | { ok: true; generation: number; decisions: Decision[]; engine: EngineStatus }
  | { ok: false; generation: number; error: string; stale?: boolean; engine: EngineStatus | null };

export interface OffscreenClassify extends Omit<ClassifyRequest, "type"> {
  type: "off:classify";
  target: "offscreen";
  /** Identifies the requesting frame so stale work can be dropped per frame. */
  frameKey: string;
}

export interface OffscreenStatusRequest {
  type: "off:status";
  target: "offscreen";
}

export interface OffscreenStatsRequest {
  type: "off:stats";
  target: "offscreen";
}

/** Diagnostic counters (benchmarks, options-page diagnostics). */
export interface EngineStats {
  jobs: number;
  staleDropped: number;
  embedded: number;
  cacheHits: number;
  embedMs: number;
  canaryFailures: number;
  wasmMemoryBytes: number | null;
}

export interface OffscreenStatusChanged {
  type: "off:status-changed";
  status: EngineStatus;
}

export interface UiStatusRequest {
  type: "ui:status";
}

export interface RegistrationStatus {
  registered: boolean;
  error: string | null;
  updatedAt: number;
}

export interface UiStatusReply {
  engine: EngineStatus;
  registration: RegistrationStatus;
}

export interface TabStateRequest {
  type: "tab:state";
}

export type TabActivity = "active" | "excluded" | "paused" | "no-topics" | "stopped";

export interface TabStateReply {
  activity: TabActivity;
  blurred: number;
  revealed: number;
  analyzed: number;
  engine: EngineStatus | null;
}

// ── Worker protocol (offscreen ⇄ engine.worker) ───────────────────────────

export type WorkerRequest =
  | { type: "init"; backend: Backend; wasmUrl: string; weightsUrl: string; vocabUrl: string }
  | { type: "embed"; id: number; texts: string[] };

export type WorkerResponse =
  | { type: "ready"; backend: Backend; dim: number; loadMs: number; wasmMemoryBytes: number }
  | { type: "init-failed"; error: string }
  | { type: "embedded"; id: number; vectors: Float32Array; ms: number; wasmMemoryBytes: number }
  | { type: "embed-failed"; id: number; error: string };

// ── Runtime guards for untrusted inbound messages ──────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isTopicList(v: unknown): v is TopicSnapshot[] {
  return (
    Array.isArray(v) &&
    v.length <= LIMITS.maxTopics &&
    v.every((t) => isObject(t) && typeof t.id === "string" && typeof t.text === "string" && t.text.length <= LIMITS.maxTopicChars)
  );
}

function isTextList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length <= LIMITS_PROTOCOL.maxTextsPerRequest &&
    v.every((t) => typeof t === "string" && t.length <= LIMITS_PROTOCOL.maxTextChars)
  );
}

export function isClassifyRequest(v: unknown): v is ClassifyRequest {
  return (
    isObject(v) &&
    v.type === "cs:classify" &&
    Number.isSafeInteger(v.generation) &&
    FILTER_MODES.includes(v.mode as FilterMode) &&
    isTopicList(v.topics) &&
    isTextList(v.texts)
  );
}

export function isOffscreenMessage(v: unknown): v is OffscreenClassify | OffscreenStatusRequest | OffscreenStatsRequest {
  if (!isObject(v) || v.target !== "offscreen") return false;
  if (v.type === "off:status" || v.type === "off:stats") return true;
  return (
    v.type === "off:classify" &&
    typeof v.frameKey === "string" &&
    isClassifyRequest({ ...v, type: "cs:classify" })
  );
}

export function initialEngineStatus(model: string): EngineStatus {
  return { state: "idle", backend: null, model, detail: null, loadMs: null, updatedAt: Date.now() };
}

/** Short, user-facing description of the engine state. */
export function describeEngine(s: EngineStatus): string {
  switch (s.state) {
    case "idle":
      return "Idle — the model loads when a page needs it";
    case "loading":
      return "Loading model…";
    case "semantic":
      return `Semantic engine active (${s.backend === "webgpu" ? "WebGPU" : "CPU"})`;
    case "lexical-fallback":
      return "Keyword matching only (semantic engine unavailable)";
    case "error":
      return "Engine error";
  }
}
