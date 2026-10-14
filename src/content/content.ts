/**
 * content.ts — content-script entry point (isolated world).
 *
 * Wires FilterController to Chrome APIs. Guarded so that being injected twice
 * (registered script + injection into an already-open tab) is harmless. The
 * guard records a liveness check rather than a flag: after an extension update
 * the previous instance is orphaned (its chrome.runtime.id is gone) and must
 * not prevent the new one from starting.
 */

import type { ClassifyReply, TabStateReply } from "../shared/protocol.ts";
import { STORAGE_KEYS, SETTINGS_KEY, migrateSettings } from "../shared/settings.ts";
import { FilterController } from "./controller.ts";

const TAG = "[ClearScroll]";
interface Guard {
  alive(): boolean;
}
const g = globalThis as { __clearscroll?: Guard };

function contextAlive(): boolean {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

if (!g.__clearscroll?.alive()) {
  g.__clearscroll = { alive: contextAlive };

  const controller = new FilterController({
    doc: document,
    classify: (req) => chrome.runtime.sendMessage(req) as Promise<ClassifyReply>,
    onInvalidated: () => console.info(TAG, "extension was reloaded or removed; filtering stopped"),
  });

  const refresh = () => {
    chrome.storage.local.get([...STORAGE_KEYS]).then(
      (stored) => controller.applySettings(migrateSettings(stored).settings, location.href),
      (err) => console.warn(TAG, "could not read settings", err)
    );
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]) refresh();
  });

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || (msg as { type?: string } | null)?.type !== "tab:state") return false;
    sendResponse(controller.getState() satisfies TabStateReply);
    return false;
  });

  if (document.body) refresh();
  else document.addEventListener("DOMContentLoaded", refresh, { once: true });
}
