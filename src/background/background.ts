/**
 * background.ts — MV3 service worker.
 *
 * Responsibilities:
 *  1. Settings migration (IdeaBlocker → ClearScroll schema v2).
 *  2. Content-script registration that mirrors the settings: registered only
 *     while filtering is active, with excludeMatches generated from the same
 *     site rules the content script uses (src/shared/sites.ts). Syncs are
 *     serialised so rapid settings changes cannot interleave register/update
 *     calls, and every Chrome API error is recorded and surfaced in the UI.
 *  3. Injection into tabs that were already open when filtering became active
 *     (Chrome only injects registered scripts on navigation).
 *  4. Offscreen document lifecycle and routing of classification requests to it.
 *  5. Image requests (cs:vision): re-checked here against the current settings
 *     (image filtering on, site not excluded) and, for downloads, the user's
 *     download permission and the URL eligibility rules, before they reach
 *     the offscreen document. Content scripts are the only senders accepted.
 */

import {
  type ClassifyReply,
  type EngineStatus,
  type OffscreenClassify,
  type RegistrationStatus,
  type UiStatusReply,
  initialEngineStatus,
  isClassifyRequest,
} from "../shared/protocol.ts";
import { STORAGE_KEYS, SETTINGS_KEY, LEGACY_TARGET_KEY, LEGACY_V1_KEY, MIGRATION_NOTES_KEY, isFilteringActive, isImageFilteringActive, migrateSettings, normalizeSettings, shouldInjectOpenTabs, type Settings } from "../shared/settings.ts";
import { isUrlExcluded, rulesToExcludeMatches } from "../shared/sites.ts";
import { checkImageUrl, initialVisionStatus, isVisionRequest, type OffscreenVision, type SkipReason, type VisionReply, type VisionStatus } from "../shared/vision.ts";

const TAG = "[ClearScroll/background]";
const SCRIPT_ID = "clearscroll-content";
const LEGACY_SCRIPT_IDS = ["ideablocker-extractor"];
const HOST_MATCHES = ["http://*/*", "https://*/*"];
const OFFSCREEN_PATH = "offscreen/offscreen.html";

let engineStatus: EngineStatus = initialEngineStatus("unknown");
let visionStatus: VisionStatus = initialVisionStatus();
// Last registration error, kept in session storage so the diagnostics survive
// service-worker restarts. Whether the script is registered is always read
// from Chrome itself (registrationStatus), never cached.
const REG_ERROR_KEY = "clearscroll_registration_error";

async function setRegistrationError(error: string | null): Promise<void> {
  await chrome.storage.session.set({ [REG_ERROR_KEY]: error });
}

async function registrationStatus(): Promise<RegistrationStatus> {
  const [scripts, stored] = await Promise.all([
    chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }),
    chrome.storage.session.get(REG_ERROR_KEY),
  ]);
  return { registered: scripts.length > 0, error: (stored[REG_ERROR_KEY] as string | null | undefined) ?? null, updatedAt: Date.now() };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Settings ───────────────────────────────────────────────────────────────

let settingsCache: Promise<Settings> | null = null;

/** Cached; invalidated on every storage change. */
function loadSettings(): Promise<Settings> {
  settingsCache ??= readSettings().catch((err) => {
    settingsCache = null;
    throw err;
  });
  return settingsCache;
}

async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get([...STORAGE_KEYS]);
  const { settings, changed, from, droppedSites } = migrateSettings(stored);
  if (changed) {
    // Record unconvertible rules before overwriting, so the user can see them.
    if (droppedSites.length) await chrome.storage.local.set({ [MIGRATION_NOTES_KEY]: { droppedSites } });
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    if (from === "v1" || from === "legacy-target") {
      await chrome.storage.local.remove([LEGACY_V1_KEY, LEGACY_TARGET_KEY]);
      console.info(TAG, `migrated settings from ${from}`);
    }
  }
  return settings;
}

// ── Content-script registration ───────────────────────────────────────────

let syncChain: Promise<void> = Promise.resolve();

/** Queue a sync; concurrent callers share the serialised chain. */
function scheduleSync(reason: string, injectExisting: boolean): Promise<void> {
  syncChain = syncChain
    .then(() => syncRegistration(reason, injectExisting))
    .catch(async (err) => {
      console.error(TAG, "sync failed", err);
      await setRegistrationError(errorText(err)).catch(() => undefined);
    });
  return syncChain;
}

async function syncRegistration(reason: string, injectExisting: boolean): Promise<void> {
  const settings = await loadSettings();
  const active = isFilteringActive(settings);
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const stale = existing.map((s) => s.id).filter((id) => LEGACY_SCRIPT_IDS.includes(id));
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
  const isRegistered = existing.some((s) => s.id === SCRIPT_ID);

  if (!active) {
    if (isRegistered) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    await setRegistrationError(null);
    await closeOffscreen();
    console.info(TAG, `sync (${reason}): filtering inactive, content script unregistered`);
    return;
  }

  const script: chrome.scripting.RegisteredContentScript = {
    id: SCRIPT_ID,
    js: ["content/content.js"],
    css: ["content/content.css"],
    matches: HOST_MATCHES,
    excludeMatches: rulesToExcludeMatches(settings.excludedSites),
    runAt: "document_idle",
    allFrames: false,
    persistAcrossSessions: true,
  };
  if (isRegistered) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
  await setRegistrationError(null);
  console.info(TAG, `sync (${reason}): registered, ${script.excludeMatches!.length} exclude patterns`);

  // Engine preference changes require a fresh offscreen document.
  await reconcileOffscreen(settings);
  // Image filtering turned off: unload the image model (text keeps running).
  if (!settings.images && (await currentOffscreen())) {
    await chrome.runtime.sendMessage({ type: "off:vision-shutdown", target: "offscreen" }).catch(() => undefined);
    visionStatus = initialVisionStatus();
  }

  if (injectExisting || !isRegistered) await injectIntoOpenTabs(settings);
}

/** Inject into already-open tabs that do not have the content script yet. */
async function injectIntoOpenTabs(settings: Settings): Promise<void> {
  const tabs = await chrome.tabs.query({ url: HOST_MATCHES });
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || !tab.url || tab.discarded) return;
      if (isUrlExcluded(tab.url, settings.excludedSites)) return;
      const target = { tabId: tab.id };
      try {
        const [probe] = await chrome.scripting.executeScript({
          target,
          func: () => (globalThis as { __clearscroll?: { alive?: () => boolean } }).__clearscroll?.alive?.() === true,
        });
        if (probe?.result) return;
        await chrome.scripting.insertCSS({ target, files: ["content/content.css"] });
        await chrome.scripting.executeScript({ target, files: ["content/content.js"] });
      } catch {
        // Tabs we cannot script (Web Store, error pages, PDFs) are skipped.
      }
    })
  );
}

// ── Offscreen document ────────────────────────────────────────────────────
//
// All lifecycle operations (create / close / replace) run through one lock.
// Without it, two tabs asking for the engine at the same time both see "no
// document", both call createDocument (the second throws), or one replaces
// the other's half-loaded document — both observed in testing.

let offscreenLock: Promise<unknown> = Promise.resolve();

function withOffscreenLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = offscreenLock.then(fn, fn);
  offscreenLock = run.catch(() => undefined);
  return run;
}

function offscreenUrl(settings: Settings): string {
  return chrome.runtime.getURL(`${OFFSCREEN_PATH}?backend=${settings.engine}`);
}

async function currentOffscreen(): Promise<chrome.runtime.ExtensionContext | undefined> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  return contexts[0];
}

function ensureOffscreen(settings: Settings): Promise<void> {
  const url = offscreenUrl(settings);
  return withOffscreenLock(async () => {
    const ctx = await currentOffscreen();
    if (ctx?.documentUrl === url) return;
    if (ctx) await chrome.offscreen.closeDocument();
    engineStatus = initialEngineStatus(engineStatus.model);
    visionStatus = initialVisionStatus();
    await chrome.offscreen.createDocument({
      url,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Runs the on-device text and image classification models in Web Workers. Page text and images are analysed on this device only.",
    });
  });
}

/** Replace a running document whose engine preference is out of date. */
function reconcileOffscreen(settings: Settings): Promise<void> {
  return withOffscreenLock(async () => {
    const ctx = await currentOffscreen();
    if (ctx && ctx.documentUrl !== offscreenUrl(settings)) {
      await chrome.offscreen.closeDocument();
      engineStatus = initialEngineStatus(engineStatus.model);
      visionStatus = initialVisionStatus();
    }
  });
}

function closeOffscreen(): Promise<void> {
  return withOffscreenLock(async () => {
    if (await currentOffscreen()) {
      await chrome.offscreen.closeDocument();
      console.info(TAG, "offscreen document closed (filtering inactive)");
    }
    engineStatus = initialEngineStatus(engineStatus.model);
    visionStatus = initialVisionStatus();
  });
}

async function forwardClassify(msg: OffscreenClassify): Promise<ClassifyReply> {
  const settings = await loadSettings();
  if (!isFilteringActive(settings)) {
    return { ok: false, generation: msg.generation, error: "filtering inactive", stale: true, engine: engineStatus };
  }
  await ensureOffscreen(settings);
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = (await chrome.runtime.sendMessage(msg)) as ClassifyReply | undefined;
      if (!reply) throw new Error("no reply from engine host");
      engineStatus = reply.engine ?? engineStatus;
      return reply;
    } catch (err) {
      // The document may still be booting its listener right after creation.
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

function visionSkip(generation: number, reason: SkipReason, error: string): VisionReply {
  return { ok: false, generation, reason, error, vision: visionStatus };
}

async function forwardVision(msg: OffscreenVision, frameUrl: string | undefined): Promise<VisionReply> {
  const settings = await loadSettings();
  if (!isImageFilteringActive(settings)) return visionSkip(msg.generation, "disabled", "image filtering is off");
  if (!frameUrl || isUrlExcluded(frameUrl, settings.excludedSites)) return visionSkip(msg.generation, "disabled", "site excluded");
  if (msg.image.kind === "url") {
    // Downloads are the one network-visible behaviour: re-checked here so a
    // stale or misbehaving content script cannot trigger them.
    if (!settings.imageDownloads) return visionSkip(msg.generation, "downloads-off", "image downloads are not allowed");
    const checked = checkImageUrl(msg.image.url);
    if (!checked.ok) return visionSkip(msg.generation, "ineligible-url", checked.error);
  }
  await ensureOffscreen(settings);
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = (await chrome.runtime.sendMessage(msg)) as VisionReply | undefined;
      if (!reply) throw new Error("no reply from vision host");
      if (reply.vision) visionStatus = reply.vision;
      return reply;
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

// ── Messaging ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const type = (msg as { type?: unknown } | null)?.type;

  if (type === "cs:classify") {
    if (!sender.tab?.id || !isClassifyRequest(msg)) {
      sendResponse({ ok: false, generation: -1, error: "invalid request", engine: null } satisfies ClassifyReply);
      return false;
    }
    const frameKey = `${sender.tab.id}:${sender.frameId ?? 0}:${sender.documentId ?? ""}`;
    forwardClassify({ ...msg, type: "off:classify", target: "offscreen", frameKey })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, generation: msg.generation, error: errorText(err), engine: engineStatus } satisfies ClassifyReply));
    return true;
  }

  if (type === "cs:vision") {
    if (!sender.tab?.id || !isVisionRequest(msg)) {
      sendResponse(visionSkip(-1, "inference", "invalid request"));
      return false;
    }
    const frameKey = `${sender.tab.id}:${sender.frameId ?? 0}:${sender.documentId ?? ""}`;
    forwardVision({ ...msg, type: "off:vision", target: "offscreen", frameKey }, sender.url ?? sender.tab.url)
      .then(sendResponse)
      .catch((err) => sendResponse(visionSkip(msg.generation, "unavailable", errorText(err))));
    return true;
  }

  if (type === "off:status-changed" && sender.url?.startsWith(chrome.runtime.getURL(OFFSCREEN_PATH))) {
    engineStatus = (msg as { status: EngineStatus }).status;
    return false;
  }

  if (type === "off:vision-status-changed" && sender.url?.startsWith(chrome.runtime.getURL(OFFSCREEN_PATH))) {
    visionStatus = (msg as { status: VisionStatus }).status;
    return false;
  }

  if (type === "ui:status") {
    void (async () => {
      // Opening the UI also completes a migration that onInstalled missed.
      await loadSettings().catch(() => undefined);
      if (await currentOffscreen()) {
        try {
          engineStatus = (await chrome.runtime.sendMessage({ type: "off:status", target: "offscreen" })) ?? engineStatus;
          visionStatus = (await chrome.runtime.sendMessage({ type: "off:vision-status", target: "offscreen" })) ?? visionStatus;
        } catch {
          /* keep last known */
        }
      }
      sendResponse({ engine: engineStatus, registration: await registrationStatus(), vision: visionStatus } satisfies UiStatusReply);
    })();
    return true;
  }
  return false;
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  void scheduleSync(`installed:${details.reason}`, true);
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleSync("startup", false);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Any of the keys migration reads invalidates the cache (legacy keys too).
  if ((STORAGE_KEYS as readonly string[]).some((k) => k in changes)) settingsCache = null;
  const change = changes[SETTINGS_KEY];
  if (!change) return;
  const prev = change.oldValue === undefined ? null : normalizeSettings(change.oldValue);
  void scheduleSync("settings-changed", shouldInjectOpenTabs(prev, normalizeSettings(change.newValue)));
});
