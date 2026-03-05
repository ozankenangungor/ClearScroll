/**
 * background.ts — MV3 service worker
 *
 * Registers content scripts dynamically based on current settings so we can:
 * - avoid injecting when target is empty
 * - apply site exclusions centrally
 * - update behavior immediately on settings change
 */

import {
  LEGACY_TARGET_KEY,
  SETTINGS_KEY,
  excludedSitesToExcludeMatches,
  normalizeSettings,
  type IdeaBlockerSettings,
} from "./settings";

const SCRIPT_ID = "ideablocker-extractor";

function isFilteringEnabled(settings: IdeaBlockerSettings): boolean {
  return settings.target.trim().length > 0;
}

function logRuntimeError(context: string): void {
  const err = chrome.runtime.lastError;
  if (err) {
    console.warn("[IdeaBlocker/Background]", context, err.message);
  }
}

function getSettings(): Promise<IdeaBlockerSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SETTINGS_KEY, LEGACY_TARGET_KEY], (result) => {
      resolve(normalizeSettings(result[SETTINGS_KEY], result[LEGACY_TARGET_KEY]));
    });
  });
}

function unregisterExtractorScript(): Promise<void> {
  return new Promise((resolve) => {
    chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] }, () => {
      logRuntimeError("unregisterContentScripts");
      resolve();
    });
  });
}

function registerExtractorScript(settings: IdeaBlockerSettings): Promise<void> {
  return new Promise((resolve) => {
    chrome.scripting.registerContentScripts(
      [
        {
          id: SCRIPT_ID,
          js: ["extractor.js"],
          matches: ["http://*/*", "https://*/*"],
          runAt: "document_idle",
          persistAcrossSessions: true,
          allFrames: false,
          excludeMatches: excludedSitesToExcludeMatches(settings.excludedSites),
        },
      ],
      () => {
        logRuntimeError("registerContentScripts");
        resolve();
      }
    );
  });
}

async function syncDynamicContentScript(): Promise<void> {
  const settings = await getSettings();
  await unregisterExtractorScript();

  if (!isFilteringEnabled(settings)) {
    console.log("[IdeaBlocker/Background] Filtering disabled (empty target).");
    return;
  }

  await registerExtractorScript(settings);
}

chrome.runtime.onInstalled.addListener(() => {
  void syncDynamicContentScript();
});

chrome.runtime.onStartup.addListener(() => {
  void syncDynamicContentScript();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[SETTINGS_KEY] && !changes[LEGACY_TARGET_KEY]) return;
  void syncDynamicContentScript();
});
