/**
 * Image filtering: message protocol, request validation, image-URL
 * eligibility and the visual decision rule.
 *
 *   content script ──cs:vision──▶ background ──off:vision──▶ offscreen VisionHost ──▶ vision.worker
 *
 * An image reaches the model in one of two ways:
 *   "pixels" — the content script read the displayed image itself (same
 *              origin, CORS-approved, data: or blob: images) and sends its
 *              224×224 RGB frame. No network request is made.
 *   "url"    — the pixels are not readable from the page (cross-origin), so
 *              the offscreen document downloads the image once more, without
 *              cookies. Only when the user enabled "imageDownloads", and only
 *              for URLs that pass `checkImageUrl`.
 */

import { FILTER_MODES, LIMITS, type FilterMode } from "./settings.ts";
import type { TopicSnapshot } from "./protocol.ts";
import { RGB_FRAME_BASE64_CHARS } from "../vision/preprocess.ts";

export const VISION_LIMITS = {
  /** Image URLs longer than this are skipped (data: URLs are read in the page). */
  maxUrlChars: 4096,
  /** Downloaded image bodies larger than this are rejected. */
  maxDownloadBytes: 8 * 1024 * 1024,
  /** Decoded images with more pixels than this are rejected (≈ 6000 × 4000). */
  maxDecodedPixels: 24_000_000,
  /** Image download timeout. */
  downloadTimeoutMs: 10_000,
} as const;

export type VisionState = "off" | "idle" | "loading" | "ready" | "error";

export interface VisionStatus {
  state: VisionState;
  backend: "cpu" | null;
  model: string;
  detail: string | null;
  loadMs: number | null;
  updatedAt: number;
}

export function initialVisionStatus(): VisionStatus {
  return { state: "idle", backend: null, model: VISION_MODEL_ID, detail: null, loadMs: null, updatedAt: Date.now() };
}

export const VISION_MODEL_ID = "siglip-base-p16-224-int8";

export type VisionImage = { kind: "pixels"; rgb: string } | { kind: "url"; url: string };

export interface VisionRequest {
  type: "cs:vision";
  generation: number;
  mode: FilterMode;
  topics: TopicSnapshot[];
  image: VisionImage;
}

/** Why an image was not analysed (diagnostics; never shown per image). */
export type SkipReason =
  | "cross-origin"
  | "stale"
  | "disabled"
  | "downloads-off"
  | "ineligible-url"
  | "download-failed"
  | "decode"
  | "too-large"
  | "overloaded"
  | "unavailable"
  | "inference";

export interface VisionDecision {
  matched: boolean;
  topicId: string | null;
  /** Margin of the matched (or best) topic, see `visionScores`; not a probability. */
  score: number;
}

export type VisionReply =
  | { ok: true; generation: number; decision: VisionDecision; vision: VisionStatus }
  | { ok: false; generation: number; reason: SkipReason; error: string; vision: VisionStatus | null };

export interface OffscreenVision extends Omit<VisionRequest, "type"> {
  type: "off:vision";
  target: "offscreen";
  frameKey: string;
}

/** Status query, stats query (benchmarks) and unload (image filtering turned off). */
export interface OffscreenVisionControl {
  type: "off:vision-status" | "off:vision-stats" | "off:vision-shutdown";
  target: "offscreen";
}

export interface VisionStatusChanged {
  type: "off:vision-status-changed";
  status: VisionStatus;
}

/** Image-filtering counters of one tab (popup / tab:state). */
export interface TabImageState {
  enabled: boolean;
  analyzed: number;
  blurred: number;
  /** Images seen but not analysed, by reason. */
  skipped: Partial<Record<SkipReason, number>>;
  /** Scheduler state (diagnostics): pictures known, waiting to load, queued, in flight. */
  pipeline: { tracked: number; waiting: number; queued: number; inflight: number };
  vision: VisionStatus | null;
}

// ── Worker protocol (offscreen ⇄ vision.worker) ──────────────────────────

export type VisionWorkerRequest =
  | { type: "init"; role: "image" | "text"; ortWasmUrl: string; modelUrl: string; tokenizerUrl?: string }
  | { type: "text"; id: number; prompts: string[] }
  | { type: "image"; id: number; rgb?: Uint8Array; blob?: Blob; maxPixels: number };

export type VisionWorkerResponse =
  | { type: "ready"; loadMs: number }
  | { type: "init-failed"; error: string }
  | { type: "text-done"; id: number; vectors: Float32Array; ms: number }
  | { type: "image-done"; id: number; vector: Float32Array; ms: number }
  | { type: "failed"; id: number; error: string; reason: "decode" | "too-large" | "inference" };

// ── Validation ────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isTopicList(v: unknown): v is TopicSnapshot[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= LIMITS.maxTopics &&
    v.every((t) => isObject(t) && typeof t.id === "string" && t.id.length <= 64 && typeof t.text === "string" && t.text.length <= LIMITS.maxTopicChars)
  );
}

function isVisionImage(v: unknown): v is VisionImage {
  if (!isObject(v)) return false;
  if (v.kind === "pixels") return typeof v.rgb === "string" && v.rgb.length === RGB_FRAME_BASE64_CHARS && /^[A-Za-z0-9+/]*={0,2}$/.test(v.rgb);
  if (v.kind === "url") return typeof v.url === "string" && v.url.length <= VISION_LIMITS.maxUrlChars;
  return false;
}

export function isVisionRequest(v: unknown): v is VisionRequest {
  return (
    isObject(v) &&
    v.type === "cs:vision" &&
    Number.isSafeInteger(v.generation) &&
    FILTER_MODES.includes(v.mode as FilterMode) &&
    isTopicList(v.topics) &&
    isVisionImage(v.image)
  );
}

export function isOffscreenVisionMessage(v: unknown): v is OffscreenVision | OffscreenVisionControl {
  if (!isObject(v) || v.target !== "offscreen") return false;
  if (v.type === "off:vision-status" || v.type === "off:vision-stats" || v.type === "off:vision-shutdown") return true;
  return v.type === "off:vision" && typeof v.frameKey === "string" && isVisionRequest({ ...v, type: "cs:vision" });
}

// ── Image URL eligibility (downloads) ─────────────────────────────────────

/**
 * Whether `raw` may be downloaded by the extension. Only plain http(s) URLs
 * of public hosts: no credentials in the URL, no localhost, no private,
 * loopback, link-local or otherwise special-purpose IP ranges, no
 * single-label or .local/.internal hosts. This keeps the download path from
 * becoming a way to read intranet resources; it cannot see DNS answers
 * (a public name resolving to a private address is not detected).
 */
export function checkImageUrl(raw: string): { ok: true; url: URL } | { ok: false; error: string } {
  if (raw.length > VISION_LIMITS.maxUrlChars) return { ok: false, error: "URL too long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: `scheme ${url.protocol} not allowed` };
  if (url.username || url.password) return { ok: false, error: "credentials in URL" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") && !host.startsWith("[")) return { ok: false, error: "single-label host" };
  if (host === "localhost" || /\.(localhost|local|internal|intranet|lan|home|corp|arpa)$/.test(host)) return { ok: false, error: "local host name" };
  if (host.startsWith("[")) return isPublicIpv6(host.slice(1, -1)) ? { ok: true, url } : { ok: false, error: "non-public IPv6 address" };
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return isPublicIpv4(v4.slice(1).map(Number)) ? { ok: true, url } : { ok: false, error: "non-public IPv4 address" };
  // WHATWG URL parsing turns every numeric host form (0x7f.1, 2130706433) into
  // dotted decimal, so anything left that ends in a number is not a domain.
  if (/\.\d+$/.test(host)) return { ok: false, error: "numeric host" };
  return { ok: true, url };
}

function isPublicIpv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || b === 0)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function isPublicIpv6(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === "::" || a === "::1") return false;
  if (a.startsWith("::ffff:")) return false; // IPv4-mapped: refuse rather than re-check
  if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a.startsWith("ff")) return false;
  return true;
}

// ── Decision rule ─────────────────────────────────────────────────────────
//
// SigLIP similarities are not probabilities, and their level differs between
// topics, so an image is judged by two conditions that must both hold:
//
//   similarity = cos(image, topic)                       ≥ minSimilarity
//   margin     = similarity − max over background b of cos(image, b) ≥ minMargin
//
// BACKGROUND is a fixed list of generic "something else" descriptions. The
// margin asks whether the topic describes the image better than every generic
// alternative: a rugby photo that is merely "sports" does not become
// "football", a gold bar that is merely "money" does not become
// "cryptocurrency". The similarity floor rejects images that are close to
// nothing in particular, where every margin is noise.
//
// Background prompts whose text embedding is very close to the topic's
// (cosine ≥ BACKGROUND_SYNONYM_COSINE: "animals" vs "an animal", "cars" vs
// "a vehicle") are left out for that topic; a synonym cannot be beaten.
//
// The background list was written once, before calibration, as a broad
// taxonomy of image genres; it is not tuned per topic. The constants were
// chosen on the development image set only and then frozen before the
// held-out validation set was scored (docs/evaluation/vision/RESULTS.md).
// Scores are never shown to users as confidence.

/** Prompts per topic; their embeddings are averaged. */
export const VISION_PROMPT_TEMPLATES: readonly string[] = ["a photo of {topic}.", "a picture of {topic}.", "an image showing {topic}."];

export const VISION_BACKGROUND_PROMPTS: readonly string[] = [
  "a photo of a person.", "a photo of people.", "a photo of a crowd.", "a photo of an animal.", "a photo of food.",
  "a photo of a building.", "a photo of a landscape.", "a photo of a city street.", "a photo of a room.", "a photo of a vehicle.",
  "a photo of an object.", "a photo of sports.", "a photo of a game.", "a photo of money.", "a photo of a machine.",
  "a photo of text.", "a screenshot.", "a diagram.", "a painting.", "a logo.", "a photo of nature.", "a photo of a device.",
];

export const BACKGROUND_SYNONYM_COSINE = 0.92;

export interface VisionRule {
  minSimilarity: number;
  minMargin: number;
}

/** Per strictness; "precision" (the default) hides the fewest images. */
export const VISION_RULES: Record<FilterMode, VisionRule> = {
  precision: { minSimilarity: 0.04, minMargin: 0.0 },
  balanced: { minSimilarity: 0.04, minMargin: -0.005 },
  aggressive: { minSimilarity: 0.03, minMargin: -0.015 },
};

export function topicPrompts(topic: string): string[] {
  return VISION_PROMPT_TEMPLATES.map((t) => t.replace("{topic}", () => topic));
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Mean of L2-normalised prompt embeddings (`flat`: n × dim), re-normalised. */
export function meanVector(flat: Float32Array, n: number): Float32Array {
  const dim = flat.length / n;
  const out = new Float32Array(dim);
  for (let i = 0; i < n; i++) for (let j = 0; j < dim; j++) out[j]! += flat[i * dim + j]!;
  const norm = Math.sqrt(dot(out, out));
  if (!(norm > 0) || !Number.isFinite(norm)) throw new Error("degenerate topic embedding");
  for (let j = 0; j < dim; j++) out[j]! /= norm;
  return out;
}

/** offscreen/vision/background.json: background prompt embeddings computed at build time. */
export interface PrecomputedBackground {
  model: string;
  prompts: string[];
  vectors: number[][];
}

/** The precomputed vectors, if they describe exactly VISION_BACKGROUND_PROMPTS for this model. */
export function usableBackground(b: unknown): Float32Array[] | null {
  if (typeof b !== "object" || b === null) return null;
  const { model, prompts, vectors } = b as Partial<PrecomputedBackground>;
  if (model !== VISION_MODEL_ID || !Array.isArray(prompts) || !Array.isArray(vectors)) return null;
  if (prompts.length !== VISION_BACKGROUND_PROMPTS.length || prompts.some((p, i) => p !== VISION_BACKGROUND_PROMPTS[i])) return null;
  if (vectors.length !== prompts.length || vectors.some((v) => !Array.isArray(v) || v.length !== vectors[0]!.length || !v.every(Number.isFinite))) return null;
  return vectors.map((v) => Float32Array.from(v));
}

export interface PreparedVisionTopic {
  id: string;
  vector: Float32Array;
  /** Background vectors this topic competes with (synonyms removed). */
  background: Float32Array[];
}

export function prepareVisionTopic(id: string, vector: Float32Array, background: readonly Float32Array[]): PreparedVisionTopic {
  return { id, vector, background: background.filter((b) => dot(vector, b) < BACKGROUND_SYNONYM_COSINE) };
}

export function visionScores(image: Float32Array, topic: PreparedVisionTopic): { similarity: number; margin: number } {
  const similarity = dot(image, topic.vector);
  let bg = -1;
  for (const b of topic.background) bg = Math.max(bg, dot(image, b));
  return { similarity, margin: similarity - bg };
}

export function isVisualMatch(s: { similarity: number; margin: number }, mode: FilterMode): boolean {
  const rule = VISION_RULES[mode];
  return s.similarity >= rule.minSimilarity && s.margin >= rule.minMargin;
}

/** Decide one image against all active topics. `score` is the best margin. */
export function decideImage(image: Float32Array, topics: readonly PreparedVisionTopic[], mode: FilterMode): VisionDecision {
  let matched: { id: string; margin: number } | null = null;
  let best = -Infinity;
  for (const t of topics) {
    const s = visionScores(image, t);
    if (!Number.isFinite(s.margin)) continue;
    best = Math.max(best, s.margin);
    if (isVisualMatch(s, mode) && (!matched || s.margin > matched.margin)) matched = { id: t.id, margin: s.margin };
  }
  return matched ? { matched: true, topicId: matched.id, score: matched.margin } : { matched: false, topicId: null, score: Number.isFinite(best) ? best : 0 };
}

/** Short, user-facing description of the image model state. */
export function describeVision(s: VisionStatus | null, enabled: boolean): string {
  if (!enabled) return "Image filtering off";
  switch (s?.state ?? "idle") {
    case "off":
    case "idle":
      return "Image model not loaded yet (loads when a page has images to check)";
    case "loading":
      return "Loading image model…";
    case "ready":
      return "Image analysis active (CPU)";
    case "error":
      return "Image analysis unavailable — images are not being checked";
  }
}
