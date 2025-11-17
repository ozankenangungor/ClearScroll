/**
 * options.ts — Options page logic
 *
 * Saves/loads the user's "Block Target" string to chrome.storage.local.
 * The content script listens for storage changes and updates the worker.
 */

export {}; // Force module scope — avoids TS duplicate declaration errors

const STORAGE_KEY = "ideablocker_target";

const targetInput = document.getElementById("target") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

// ── Load saved target on page open ─────────────────────────────────────

chrome.storage.local.get([STORAGE_KEY], (result) => {
  const saved = result[STORAGE_KEY];
  if (saved && typeof saved === "string") {
    targetInput.value = saved;
  }
});

// ── Save on button click ───────────────────────────────────────────────

saveButton.addEventListener("click", () => {
  const target = targetInput.value.trim();

  chrome.storage.local.set({ [STORAGE_KEY]: target }, () => {
    if (target.length === 0) {
      showStatus("Filtering disabled.");
    } else {
      showStatus(`Blocking: "${target}"`);
    }
  });
});

// ── Save on Enter key ──────────────────────────────────────────────────

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
