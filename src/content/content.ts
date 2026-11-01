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
import type { VisionReply } from "../shared/vision.ts";
import { STORAGE_KEYS, SETTINGS_KEY, migrateSettings } from "../shared/settings.ts";
import { FilterController } from "./controller.ts";
import { openFeedback } from "./feedback.ts";

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
    classifyImage: (req) => chrome.runtime.sendMessage(req) as Promise<VisionReply>,
    onInvalidated: () => {
      closeFeedback?.();
      console.info(TAG, "extension was reloaded or removed; filtering stopped");
    },
  });

  // Last applied settings: a storage write that only normalises them (the
  // background's migration write-back) must not restart analysis.
  let applied = "";
  let closeFeedback: (() => void) | null = null;
  const refresh = () => {
    chrome.storage.local.get([...STORAGE_KEYS]).then(
      (stored) => {
        const settings = migrateSettings(stored).settings;
        const key = JSON.stringify(settings) + location.host;
        if (key === applied) return;
        closeFeedback?.();
        applied = key;
        controller.applySettings(settings, location.href);
      },
      (err) => console.warn(TAG, "could not read settings", err)
    );
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]) refresh();
  });

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if ((msg as { type?: string } | null)?.type === "tab:feedback" && sender.url === chrome.runtime.getURL("popup/popup.html")) {
      chrome.storage.local.get([...STORAGE_KEYS]).then(stored => {
        const settings = migrateSettings(stored).settings;
        const key = JSON.stringify(settings) + location.host;
        if (key !== applied) {
          applied = key;
          controller.applySettings(settings, location.href);
        }
        closeFeedback?.();
        if (controller.getState().activity !== "active") { sendResponse({ ok: false }); return; }
        // Register the picker before the controller's reveal handlers.
        closeFeedback = openFeedback(controller, settings, draft => chrome.runtime.sendMessage({ type: "feedback:save", draft }));
        sendResponse({ ok: true });
      }).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if ((msg as { type?: string } | null)?.type !== "tab:state") return false;
    sendResponse(controller.getState() satisfies TabStateReply);
    return false;
  });

  if (document.body) refresh();
  else document.addEventListener("DOMContentLoaded", refresh, { once: true });
}
