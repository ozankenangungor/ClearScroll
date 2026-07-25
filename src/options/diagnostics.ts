/**
 * "Copy diagnostics" (options page): a plain-text summary a tester pastes
 * into a bug report themselves. Built only on an explicit click, copied to
 * the clipboard, never sent anywhere. Data minimisation: no page content,
 * no URLs, no excluded sites, no browsing history; topic names only if the
 * user ticks "include my topics".
 */

import type { EngineStatus } from "../shared/protocol.ts";
import type { Settings } from "../shared/settings.ts";
import type { VisionStatus } from "../shared/vision.ts";

export interface DiagnosticsInput {
  version: string;
  /** e.g. "Chrome 153" — major version only. */
  browser: string;
  settings: Settings;
  engine: Pick<EngineStatus, "state" | "backend" | "model" | "loadMs" | "detail">;
  vision: Pick<VisionStatus, "state" | "model" | "loadMs" | "detail" | "threads"> | null;
  registered: boolean;
  includeTopics: boolean;
}

/** "Mozilla/5.0 … Chrome/153.0.8010.47 …" → "Chrome 153" (nothing else from the user agent). */
export function browserMajor(userAgent: string): string {
  const m = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent);
  return m ? `Chrome ${m[1]}` : "unknown browser";
}

export function formatDiagnostics(d: DiagnosticsInput): string {
  const s = d.settings;
  const active = s.topics.filter((t) => t.enabled);
  const lines = [
    "ClearScroll diagnostics (no page content, no addresses)",
    `Version: ${d.version} · ${d.browser}`,
    `Filtering: ${s.enabled ? "on" : "off"} · strictness ${s.mode} · text engine preference ${s.engine}`,
    `Topics: ${active.length} active of ${s.topics.length}${d.includeTopics && active.length ? ` — ${active.map((t) => JSON.stringify(t.text)).join(", ")}` : ""}`,
    `Excluded sites: ${s.excludedSites.length} · protected areas: ${s.protectedSelectors.length}`,
    `Text engine: ${d.engine.state} · backend ${d.engine.backend ?? "—"} · model ${d.engine.model} · load ${d.engine.loadMs ?? "—"} ms${d.engine.detail ? ` · ${d.engine.detail}` : ""}`,
    `Content script: ${d.registered ? "registered" : "not registered"}`,
    `Pictures: ${s.images ? "on" : "off"} · other domains ${s.imageDownloads ? "on" : "off"}`,
  ];
  if (s.images && d.vision) {
    lines.push(`Image model: ${d.vision.state} · ${d.vision.model} · threads ${d.vision.threads ?? "—"} · load ${d.vision.loadMs ?? "—"} ms${d.vision.detail ? ` · ${d.vision.detail}` : ""}`);
  }
  return lines.join("\n") + "\n";
}
