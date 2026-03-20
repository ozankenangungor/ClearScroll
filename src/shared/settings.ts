/**
 * Settings schema, defaults, validation and migration.
 *
 * Stored under SETTINGS_KEY in chrome.storage.local. Older builds (published
 * as "IdeaBlocker") stored a single target string under LEGACY_V1_KEY or
 * LEGACY_TARGET_KEY; `migrateSettings` converts them. Legacy site rules the
 * current policy cannot express (e.g. "*bank*.com") are reported in
 * `droppedSites` and surfaced to the user (MIGRATION_NOTES_KEY), never
 * dropped silently.
 */

import { parseSiteRules } from "./sites.ts";

export type FilterMode = "precision" | "balanced" | "aggressive";
export const FILTER_MODES: readonly FilterMode[] = ["precision", "balanced", "aggressive"];

/** Inference backend preference: auto = WebGPU when available, else CPU. */
export type EnginePreference = "auto" | "cpu" | "off";
export const ENGINE_PREFERENCES: readonly EnginePreference[] = ["auto", "cpu", "off"];

export interface Topic {
  id: string;
  text: string;
  enabled: boolean;
}

export interface Settings {
  schema: 2;
  /** Global pause switch; topics and rules are kept while paused. */
  enabled: boolean;
  mode: FilterMode;
  engine: EnginePreference;
  topics: Topic[];
  /** Normalised hosts (see sites.ts). */
  excludedSites: string[];
  /** Extra CSS selectors whose subtrees are never analysed or blurred. */
  protectedSelectors: string[];
  /**
   * Image filtering: analyse the pixels of images with the on-device image
   * model. Off by default (opt-in; existing users keep text-only behaviour).
   */
  images: boolean;
  /**
   * Let image filtering download a copy of images whose pixels the page does
   * not expose (other-domain images), without cookies. Off by default: this
   * is the only setting under which ClearScroll makes network requests.
   */
  imageDownloads: boolean;
}

export const SETTINGS_KEY = "clearscroll_settings";
export const LEGACY_V1_KEY = "ideablocker_settings";
export const LEGACY_TARGET_KEY = "ideablocker_target";
export const STORAGE_KEYS = [SETTINGS_KEY, LEGACY_V1_KEY, LEGACY_TARGET_KEY] as const;
/** { droppedSites: {input, error}[] } written once by migration; shown on the options page. */
export const MIGRATION_NOTES_KEY = "clearscroll_migration_notes";

export const LIMITS = {
  maxTopics: 20,
  maxTopicChars: 120,
  minTopicChars: 2,
  maxSites: 500,
  maxSelectors: 100,
  maxSelectorChars: 300,
} as const;

export function defaultSettings(): Settings {
  return {
    schema: 2,
    enabled: true,
    mode: "precision",
    engine: "auto",
    topics: [],
    excludedSites: [],
    protectedSelectors: [],
    images: false,
    imageDownloads: false,
  };
}

export function activeTopics(s: Settings): Topic[] {
  return s.topics.filter((t) => t.enabled);
}

/** Filtering runs only when globally enabled and at least one topic is on. */
export function isFilteringActive(s: Settings): boolean {
  return s.enabled && activeTopics(s).length > 0;
}

/** Image filtering runs only on top of active filtering. */
export function isImageFilteringActive(s: Settings): boolean {
  return isFilteringActive(s) && s.images;
}

/**
 * Whether a settings change can require injecting the content script into
 * already-open tabs: only when filtering becomes active or a site rule is
 * removed. Other changes (mode, topics, engine) reach running content scripts
 * through storage.onChanged, so probing every tab for them is wasted work.
 * `prev` null means unknown (e.g. first run): inject to be safe.
 */
export function shouldInjectOpenTabs(prev: Settings | null, next: Settings): boolean {
  if (!isFilteringActive(next)) return false;
  if (!prev || !isFilteringActive(prev)) return true;
  return prev.excludedSites.some((h) => !next.excludedSites.includes(h));
}

export function normalizeTopicText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function topicKey(text: string): string {
  return normalizeTopicText(text).toLowerCase();
}

export function newTopicId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export type ValidationIssue = { field: string; message: string };

export function validateTopicText(text: string, existing: readonly Topic[], selfId?: string): string | null {
  const t = normalizeTopicText(text);
  if (t.length < LIMITS.minTopicChars) return "Topic is too short.";
  if (t.length > LIMITS.maxTopicChars) return `Topic must be at most ${LIMITS.maxTopicChars} characters.`;
  const key = topicKey(t);
  if (existing.some((o) => o.id !== selfId && topicKey(o.text) === key)) return "This topic already exists.";
  return null;
}

/**
 * Validate a CSS selector without touching the page. Uses a detached
 * fragment so even pathological selectors cannot match live content.
 */
export function validateSelector(selector: string, doc: Pick<Document, "createDocumentFragment">): string | null {
  const s = selector.trim();
  if (!s) return "Empty selector.";
  if (s.length > LIMITS.maxSelectorChars) return "Selector is too long.";
  try {
    doc.createDocumentFragment().querySelector(s);
  } catch {
    return "Invalid CSS selector.";
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
}

function normalizeMode(v: unknown): FilterMode {
  return FILTER_MODES.includes(v as FilterMode) ? (v as FilterMode) : "precision";
}

function normalizeTopics(v: unknown): Topic[] {
  if (!Array.isArray(v)) return [];
  const out: Topic[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (!isRecord(item) || typeof item.text !== "string") continue;
    const text = normalizeTopicText(item.text).slice(0, LIMITS.maxTopicChars);
    const key = topicKey(text);
    if (text.length < LIMITS.minTopicChars || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: typeof item.id === "string" && item.id ? item.id.slice(0, 64) : newTopicId(),
      text,
      enabled: item.enabled !== false,
    });
    if (out.length >= LIMITS.maxTopics) break;
  }
  return out;
}

/**
 * Coerce untrusted stored data into a valid Settings object. Invalid entries
 * are dropped rather than throwing, so a corrupted store can never brick the
 * extension; the options page validates before saving so this is a backstop.
 */
export function normalizeSettings(raw: unknown): Settings {
  const base = defaultSettings();
  if (!isRecord(raw)) return base;
  return {
    schema: 2,
    enabled: raw.enabled !== false,
    mode: normalizeMode(raw.mode),
    engine: ENGINE_PREFERENCES.includes(raw.engine as EnginePreference) ? (raw.engine as EnginePreference) : "auto",
    topics: normalizeTopics(raw.topics),
    excludedSites: parseSiteRules(stringList(raw.excludedSites)).hosts.slice(0, LIMITS.maxSites),
    protectedSelectors: [...new Set(stringList(raw.protectedSelectors))]
      .filter((s) => s.length <= LIMITS.maxSelectorChars)
      .slice(0, LIMITS.maxSelectors),
    // Strictly `true`: anything else (missing in older settings, corrupted) is off.
    images: raw.images === true,
    imageDownloads: raw.imageDownloads === true,
  };
}

export interface MigrationResult {
  settings: Settings;
  /** True when the result differs from what is stored under SETTINGS_KEY. */
  changed: boolean;
  from: "current" | "v1" | "legacy-target" | "none";
  /** Stored site rules that could not be converted (empty when none). */
  droppedSites: { input: string; error: string }[];
}

/** Build current settings from whatever keys exist in storage. */
export function migrateSettings(stored: Record<string, unknown>): MigrationResult {
  const current = stored[SETTINGS_KEY];
  if (current !== undefined) {
    const settings = normalizeSettings(current);
    const droppedSites = isRecord(current) ? parseSiteRules(stringList(current.excludedSites)).errors : [];
    return { settings, changed: JSON.stringify(settings) !== JSON.stringify(current), from: "current", droppedSites };
  }

  const v1 = stored[LEGACY_V1_KEY];
  const legacyTarget = stored[LEGACY_TARGET_KEY];
  if (isRecord(v1) || typeof legacyTarget === "string") {
    const rec = isRecord(v1) ? v1 : {};
    const target = typeof rec.target === "string" ? rec.target : typeof legacyTarget === "string" ? legacyTarget : "";
    const settings = normalizeSettings({
      enabled: true,
      mode: rec.mode,
      topics: target.trim() ? [{ text: target, enabled: true }] : [],
      excludedSites: rec.excludedSites,
      protectedSelectors: rec.protectedSelectors,
    });
    const droppedSites = parseSiteRules(stringList(rec.excludedSites)).errors;
    return { settings, changed: true, from: isRecord(v1) ? "v1" : "legacy-target", droppedSites };
  }

  return { settings: defaultSettings(), changed: false, from: "none", droppedSites: [] };
}

export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
