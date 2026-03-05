export type FilterMode = "precision" | "balanced" | "aggressive";

export interface IdeaBlockerSettings {
  target: string;
  mode: FilterMode;
  excludedSites: string[];
  protectedSelectors: string[];
}

export const LEGACY_TARGET_KEY = "ideablocker_target";
export const SETTINGS_KEY = "ideablocker_settings";

export const DEFAULT_SETTINGS: IdeaBlockerSettings = {
  target: "",
  mode: "precision",
  excludedSites: [],
  protectedSelectors: [],
};

function normalizeList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = String(value || "").trim();
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizeMode(value: unknown): FilterMode {
  if (value === "balanced" || value === "aggressive" || value === "precision") {
    return value;
  }
  return DEFAULT_SETTINGS.mode;
}

export function normalizeSettings(
  rawSettings: unknown,
  rawLegacyTarget?: unknown
): IdeaBlockerSettings {
  const base = DEFAULT_SETTINGS;

  if (!rawSettings || typeof rawSettings !== "object") {
    const target = String(rawLegacyTarget || "").trim();
    return { ...base, target };
  }

  const typed = rawSettings as Partial<IdeaBlockerSettings>;
  const target = String(typed.target ?? rawLegacyTarget ?? "").trim();
  return {
    target,
    mode: normalizeMode(typed.mode),
    excludedSites: normalizeList(typed.excludedSites),
    protectedSelectors: normalizeList(typed.protectedSelectors),
  };
}

export function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function listToMultiline(values: string[]): string {
  return values.join("\n");
}

function patternToRegex(pattern: string): RegExp | null {
  let normalized = pattern.trim().toLowerCase();
  if (!normalized) return null;

  normalized = normalized
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\*\./, "*.");

  const escaped = normalized
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  try {
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null;
  }
}

export function isSiteExcluded(url: string, patterns: string[]): boolean {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const pattern of patterns) {
    const regex = patternToRegex(pattern);
    if (regex && regex.test(hostname)) {
      return true;
    }
  }
  return false;
}

function normalizeHostPattern(pattern: string): string | null {
  let host = pattern.trim().toLowerCase();
  if (!host) return null;

  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!host) return null;
  return host;
}

export function hostPatternToMatchPatterns(pattern: string): string[] {
  const host = normalizeHostPattern(pattern);
  if (!host) return [];

  const out = new Set<string>();

  // Wildcard subdomain pattern: *.example.com
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    if (!base) return [];
    out.add(`*://*.${base}/*`);
    out.add(`*://${base}/*`);
    return Array.from(out);
  }

  // Generic host wildcard pattern: *foo*bar.com
  if (host.includes("*")) {
    out.add(`*://${host}/*`);
    return Array.from(out);
  }

  // Exact host + subdomains by default for UX convenience.
  out.add(`*://${host}/*`);
  out.add(`*://*.${host}/*`);
  return Array.from(out);
}

export function excludedSitesToExcludeMatches(patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const match of hostPatternToMatchPatterns(pattern)) {
      out.add(match);
    }
  }
  return Array.from(out);
}
