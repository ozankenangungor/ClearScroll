/**
 * options.ts — Options page logic
 *
 * Stores precision/speed settings in chrome.storage.local.
 */

import {
  DEFAULT_SETTINGS,
  LEGACY_TARGET_KEY,
  SETTINGS_KEY,
  type IdeaBlockerSettings,
  listToMultiline,
  normalizeSettings,
  parseLines,
} from "./settings";

export {}; // Force module scope — avoids TS duplicate declaration errors

const targetInput = document.getElementById("target") as HTMLInputElement;
const modeSelect = document.getElementById("mode") as HTMLSelectElement;
const excludedSitesInput = document.getElementById("excludedSites") as HTMLTextAreaElement;
const protectedSelectorsInput = document.getElementById("protectedSelectors") as HTMLTextAreaElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

function applyToForm(settings: IdeaBlockerSettings): void {
  targetInput.value = settings.target;
  modeSelect.value = settings.mode;
  excludedSitesInput.value = listToMultiline(settings.excludedSites);
  protectedSelectorsInput.value = listToMultiline(settings.protectedSelectors);
}

function readFromForm(): IdeaBlockerSettings {
  return {
    target: targetInput.value.trim(),
    mode: (modeSelect.value as IdeaBlockerSettings["mode"]) || DEFAULT_SETTINGS.mode,
    excludedSites: parseLines(excludedSitesInput.value),
    protectedSelectors: parseLines(protectedSelectorsInput.value),
  };
}

// ── Load on open ───────────────────────────────────────────────────────

chrome.storage.local.get([SETTINGS_KEY, LEGACY_TARGET_KEY], (result) => {
  const settings = normalizeSettings(result[SETTINGS_KEY], result[LEGACY_TARGET_KEY]);
  applyToForm(settings);
});

// ── Save ───────────────────────────────────────────────────────────────

saveButton.addEventListener("click", () => {
  const settings = readFromForm();

  chrome.storage.local.set(
    {
      [SETTINGS_KEY]: settings,
      // Backward compatibility for legacy builds still reading only target.
      [LEGACY_TARGET_KEY]: settings.target,
    },
    () => {
      showStatus(
        settings.target
          ? `Saved (${settings.mode}). Excluded: ${settings.excludedSites.length}`
          : "Filtering disabled."
      );
    }
  );
});

targetInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    saveButton.click();
  }
});

// ── Status flash ───────────────────────────────────────────────────────

let statusTimer: ReturnType<typeof setTimeout> | null = null;

function showStatus(message: string): void {
  statusEl.textContent = message;
  statusEl.style.opacity = "1";

  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.style.opacity = "0";
  }, 3000);
}
