/**
 * popup.ts — toolbar popup: status for the current tab plus quick controls.
 */

import { describeEngine, type TabStateReply, type UiStatusReply } from "../shared/protocol.ts";
import { SETTINGS_KEY, STORAGE_KEYS, activeTopics, migrateSettings, type Settings } from "../shared/settings.ts";
import { hostMatchesRule, parseSiteRule } from "../shared/sites.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const engineEl = $<HTMLParagraphElement>("engine");
const hostEl = $<HTMLParagraphElement>("site-host");
const stateEl = $<HTMLParagraphElement>("site-state");
const enabledEl = $<HTMLInputElement>("enabled");
const toggleSite = $<HTMLButtonElement>("toggle-site");
const topicsEl = $<HTMLParagraphElement>("topics");

let settings: Settings;
let host: string | null = null;
let tabId: number | undefined;

async function save(next: Settings): Promise<void> {
  settings = next;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  await render();
}

function coveringRules(): string[] {
  return host ? settings.excludedSites.filter((rule) => hostMatchesRule(host!, rule)) : [];
}

async function render(): Promise<void> {
  enabledEl.checked = settings.enabled;
  const topics = activeTopics(settings);
  topicsEl.textContent = topics.length
    ? `Hiding: ${topics.map((t) => t.text).join(", ")}`
    : "No active topics — add one in Settings.";

  const rules = coveringRules();
  toggleSite.hidden = !host;
  toggleSite.textContent = rules.length ? "Run on this site again" : "Never run on this site";

  let tab: TabStateReply | null = null;
  if (tabId !== undefined && host) {
    tab = await chrome.tabs.sendMessage(tabId, { type: "tab:state" }).catch(() => null);
  }
  if (!host) stateEl.textContent = "ClearScroll does not run on this kind of page.";
  else if (rules.length) stateEl.textContent = `Excluded by your site rules (${rules.join(", ")}).`;
  else if (!settings.enabled) stateEl.textContent = "Filtering is turned off.";
  else if (!topics.length) stateEl.textContent = "Nothing to hide yet.";
  else if (!tab) stateEl.textContent = "Reload the page to start filtering here.";
  else if (tab.activity !== "active") stateEl.textContent = "Not filtering on this page.";
  else stateEl.textContent = `${tab.blurred} item${tab.blurred === 1 ? "" : "s"} hidden${tab.revealed ? `, ${tab.revealed} revealed` : ""}.`;

  try {
    const status = (await chrome.runtime.sendMessage({ type: "ui:status" })) as UiStatusReply;
    const engine = tab?.engine && tab.engine.updatedAt > status.engine.updatedAt ? tab.engine : status.engine;
    engineEl.dataset.state = settings.enabled ? engine.state : "idle";
    engineEl.textContent = settings.enabled ? describeEngine(engine) : "Filtering off";
  } catch {
    engineEl.textContent = "Status unavailable";
  }
}

enabledEl.addEventListener("change", () => void save({ ...settings, enabled: enabledEl.checked }));

toggleSite.addEventListener("click", () => {
  if (!host) return;
  const rules = coveringRules();
  if (rules.length) {
    void save({ ...settings, excludedSites: settings.excludedSites.filter((r) => !rules.includes(r)) });
  } else {
    const parsed = parseSiteRule(host);
    if (parsed.ok) void save({ ...settings, excludedSites: [...settings.excludedSites, parsed.host] });
  }
});

$<HTMLButtonElement>("open-options").addEventListener("click", () => void chrome.runtime.openOptionsPage());

(async () => {
  const [stored, [tab]] = await Promise.all([
    chrome.storage.local.get([...STORAGE_KEYS]),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  settings = migrateSettings(stored).settings;
  tabId = tab?.id;
  try {
    const url = new URL(tab?.url ?? "");
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch {
    host = null;
  }
  hostEl.textContent = host ?? "—";
  await render();
})();
