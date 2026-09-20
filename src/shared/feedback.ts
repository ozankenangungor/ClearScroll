/** Metadata only. Never accept page strings, URLs, selectors, or engine error details. */
import { FILTER_MODES, type FilterMode } from "./settings.ts";
export const FEEDBACK_KEY = "clearscroll_feedback";
export const FEEDBACK_LIMIT = 100;
export const FEEDBACK_TTL_MS = 30 * 86400_000;
export interface FeedbackDraft {
  kind: "wrongly-hidden" | "should-hide";
  topicId: string;
  mode: FilterMode;
  decision: "hidden" | "visible" | "revealed";
  target: { tag: string; ordinal: number };
  diagnostics: null | {
    path: string;
    analyzed: boolean;
    matched: boolean | null;
    via: "semantic" | "lexical" | null;
    score: number | null;
    similarity: number | null;
    rivalled: boolean | null;
    backend: "cpu" | "webgpu" | null;
    state: "idle" | "loading" | "semantic" | "lexical-fallback" | "error";
  };
}
export interface FeedbackRecord extends FeedbackDraft {
  id: string;
  createdAt: number;
  version: string;
  topic: string;
  reviewStatus: "unreviewed-user-report";
}
/** Rebuild from an allowlist, dropping ALL unknown fields before storage. */
export function sanitizeFeedback(value: unknown): FeedbackDraft | null {
  if (!value || typeof value !== "object") return null;
  const v = value as FeedbackDraft;
  if (!["wrongly-hidden", "should-hide"].includes(v.kind) || typeof v.topicId !== "string" || v.topicId.length > 100 ||
      !FILTER_MODES.includes(v.mode) || !["hidden", "visible", "revealed"].includes(v.decision) ||
      (v.kind === "wrongly-hidden" ? v.decision === "visible" : v.decision !== "visible") ||
      !v.target || typeof v.target.tag !== "string" || !/^[a-z][a-z0-9]{0,15}$/.test(v.target.tag) ||
      !Number.isInteger(v.target.ordinal) || v.target.ordinal < 1 || v.target.ordinal > 100000) return null;
  let diagnostics: FeedbackDraft["diagnostics"] = null;
  if (v.diagnostics !== null) {
    const d = v.diagnostics;
    if (!d || typeof d.path !== "string" || d.path.length > 300 ||
        !/^[a-z][a-z0-9]*:nth-of-type\([1-9][0-9]*\)( > [a-z][a-z0-9]*:nth-of-type\([1-9][0-9]*\))*$/.test(d.path) ||
        typeof d.analyzed !== "boolean" || ![true, false, null].includes(d.matched) ||
        !["semantic", "lexical", null].includes(d.via) || ![true, false, null].includes(d.rivalled) ||
        !["cpu", "webgpu", null].includes(d.backend) ||
        !["idle", "loading", "semantic", "lexical-fallback", "error"].includes(d.state) ||
        ![d.score, d.similarity].every(n => n === null || (typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 10))) return null;
    diagnostics = { path: d.path, analyzed: d.analyzed, matched: d.matched, via: d.via, score: d.score, similarity: d.similarity, rivalled: d.rivalled, backend: d.backend, state: d.state };
  }
  return { kind: v.kind, topicId: v.topicId, mode: v.mode, decision: v.decision, target: { tag: v.target.tag, ordinal: v.target.ordinal }, diagnostics };
}
export function retainedFeedback(value: unknown, now: number): FeedbackRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(v => {
    const draft = sanitizeFeedback(v);
    if (!draft || typeof v.id !== "string" || !/^[a-f0-9-]{36}$/.test(v.id) ||
        typeof v.createdAt !== "number" || v.createdAt > now || now - v.createdAt >= FEEDBACK_TTL_MS ||
        typeof v.topic !== "string" || v.topic.length > 120 ||
        typeof v.version !== "string" || !/^\d+\.\d+\.\d+$/.test(v.version)) return [];
    return [{ ...draft, id: v.id, createdAt: v.createdAt, version: v.version, topic: v.topic, reviewStatus: "unreviewed-user-report" as const }];
  }).slice(-FEEDBACK_LIMIT);
}
