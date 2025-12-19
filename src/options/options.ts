/**
 * options.ts — settings page.
 *
 * The form edits a draft copy of the settings. Saving validates everything
 * first (topics, site rules, CSS selectors); invalid input is reported next
 * to the field and nothing is written until it is fixed.
 */

import { describeEngine, type UiStatusReply } from "../shared/protocol.ts";
import {
  ENGINE_PREFERENCES,
  FILTER_MODES,
  LIMITS,
  MIGRATION_NOTES_KEY,
  SETTINGS_KEY,
  STORAGE_KEYS,
  migrateSettings,
  newTopicId,
  normalizeTopicText,
  parseLines,
  validateSelector,
  validateTopicText,
  type EnginePreference,
  type FilterMode,
  type Settings,
  type Topic,
} from "../shared/settings.ts";
import { parseSiteRules } from "../shared/sites.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("settings-form");
const enabledInput = $<HTMLInputElement>("enabled");
const topicList = $<HTMLUListElement>("topic-list");
const topicEmpty = $<HTMLParagraphElement>("topic-empty");
const newTopicInput = $<HTMLInputElement>("new-topic");
const newTopicError = $<HTMLParagraphElement>("new-topic-error");
const sitesInput = $<HTMLTextAreaElement>("excluded-sites");
const sitesError = $<HTMLUListElement>("sites-error");
const selectorsInput = $<HTMLTextAreaElement>("protected-selectors");
const selectorsError = $<HTMLUListElement>("selectors-error");
const engineSelect = $<HTMLSelectElement>("engine");
const saveStatus = $<HTMLParagraphElement>("save-status");
const dirtyNote = $<HTMLSpanElement>("dirty-note");
const engineStatusEl = $<HTMLSpanElement>("engine-status");
const diagnostics = $<HTMLDListElement>("diagnostics");

let saved: Settings;
let topics: Topic[] = [];

function setStatus(text: string, kind: "ok" | "error" | "" = ""): void {
  saveStatus.textContent = text;
  saveStatus.dataset.kind = kind;
}

function markDirty(): void {
  dirtyNote.hidden = false;
  setStatus("");
}

function fillErrors(list: HTMLUListElement, field: HTMLElement, errors: string[]): void {
  list.replaceChildren(...errors.map((e) => Object.assign(document.createElement("li"), { textContent: e })));
  field.setAttribute("aria-invalid", errors.length ? "true" : "false");
}

// ── Topics ────────────────────────────────────────────────────────────────

function renderTopics(): void {
  topicList.replaceChildren(
    ...topics.map((topic) => {
      const li = document.createElement("li");
      li.className = "topic-row";
      li.dataset.enabled = String(topic.enabled);
      li.dataset.topicId = topic.id;

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = topic.enabled;
      toggle.setAttribute("aria-label", `Enable topic “${topic.text}”`);
      toggle.addEventListener("change", () => {
        topic.enabled = toggle.checked;
        li.dataset.enabled = String(topic.enabled);
        markDirty();
      });

      const text = document.createElement("input");
      text.type = "text";
      text.value = topic.text;
      text.maxLength = LIMITS.maxTopicChars;
      text.setAttribute("aria-label", "Topic text");
      const err = document.createElement("p");
      err.className = "error-text row-error";
      err.id = `err-${topic.id}`;
      text.setAttribute("aria-describedby", err.id);
      text.addEventListener("input", () => {
        topic.text = text.value;
        err.textContent = "";
        text.removeAttribute("aria-invalid");
        markDirty();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-quiet";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove topic “${topic.text}”`);
      remove.addEventListener("click", () => {
        topics = topics.filter((t) => t !== topic);
        renderTopics();
        markDirty();
        newTopicInput.focus();
      });

      li.append(toggle, text, remove, err);
      return li;
    })
  );
  topicEmpty.hidden = topics.length > 0;
}

/** Returns false (and shows why) when the pending text cannot be added. */
function addTopic(): boolean {
  const text = normalizeTopicText(newTopicInput.value);
  const error =
    topics.length >= LIMITS.maxTopics ? `At most ${LIMITS.maxTopics} topics.` : validateTopicText(text, topics);
  newTopicError.textContent = error ?? "";
  newTopicInput.setAttribute("aria-invalid", error ? "true" : "false");
  if (error) return false;
  topics.push({ id: newTopicId(), text, enabled: true });
  newTopicInput.value = "";
  renderTopics();
  markDirty();
  return true;
}

$<HTMLButtonElement>("add-topic").addEventListener("click", addTopic);
newTopicInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addTopic();
  }
});

// ── Load / save ───────────────────────────────────────────────────────────

function applyToForm(s: Settings): void {
  saved = s;
  topics = s.topics.map((t) => ({ ...t }));
  enabledInput.checked = s.enabled;
  form.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => (r.checked = r.value === s.mode));
  sitesInput.value = s.excludedSites.join("\n");
  selectorsInput.value = s.protectedSelectors.join("\n");
  engineSelect.value = s.engine;
  renderTopics();
  dirtyNote.hidden = true;
}

/** Validate the whole form; returns settings or null (errors are shown). */
function readForm(): Settings | null {
  let ok = true;

  const seen: Topic[] = [];
  const cleanTopics: Topic[] = [];
  for (const t of topics) {
    const row = topicList.querySelector<HTMLLIElement>(`[data-topic-id="${CSS.escape(t.id)}"]`);
    const err = validateTopicText(t.text, seen);
    if (row) {
      row.querySelector(".row-error")!.textContent = err ?? "";
      row.querySelector('input[type="text"]')!.setAttribute("aria-invalid", err ? "true" : "false");
    }
    if (err) ok = false;
    const clean = { ...t, text: normalizeTopicText(t.text) };
    seen.push(clean);
    cleanTopics.push(clean);
  }

  const siteLines = parseLines(sitesInput.value);
  const sites = parseSiteRules(siteLines);
  const siteErrors = sites.errors.map((e) => `“${e.input}”: ${e.error}`);
  if (sites.hosts.length > LIMITS.maxSites) siteErrors.push(`At most ${LIMITS.maxSites} sites.`);
  fillErrors(sitesError, sitesInput, siteErrors);
  if (siteErrors.length) ok = false;

  const selectors = [...new Set(parseLines(selectorsInput.value))];
  const selectorErrors = selectors.flatMap((s) => {
    const e = validateSelector(s, document);
    return e ? [`“${s}”: ${e}`] : [];
  });
  if (selectors.length > LIMITS.maxSelectors) selectorErrors.push(`At most ${LIMITS.maxSelectors} selectors.`);
  fillErrors(selectorsError, selectorsInput, selectorErrors);
  if (selectorErrors.length) {
    ok = false;
    (selectorsInput.closest("details") as HTMLDetailsElement).open = true;
  }

  if (!ok) return null;
  const mode = (form.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? "precision") as FilterMode;
  const engine = engineSelect.value as EnginePreference;
  return {
    schema: 2,
    enabled: enabledInput.checked,
    mode: FILTER_MODES.includes(mode) ? mode : "precision",
    engine: ENGINE_PREFERENCES.includes(engine) ? engine : "auto",
    topics: cleanTopics,
    excludedSites: sites.hosts,
    protectedSelectors: selectors,
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  // A topic typed but not yet added must not be silently discarded.
  if (normalizeTopicText(newTopicInput.value) && !addTopic()) {
    setStatus("Not saved — the new topic is not valid (see the message under it).", "error");
    newTopicInput.focus();
    return;
  }
  const next = readForm();
  if (!next) {
    setStatus("Not saved — please fix the highlighted fields.", "error");
    (form.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus();
    return;
  }
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    applyToForm(next);
    const n = next.topics.filter((t) => t.enabled).length;
    setStatus(
      !next.enabled ? "Saved. Filtering is turned off." : n === 0 ? "Saved. Add a topic to start filtering." : `Saved. Filtering ${n} topic${n === 1 ? "" : "s"}.`,
      "ok"
    );
  } catch (err) {
    setStatus(`Could not save: ${String(err)}`, "error");
  }
});

form.addEventListener("input", (e) => {
  if (e.target !== newTopicInput) markDirty();
});

chrome.storage.onChanged.addListener((changes, area) => {
  // Reflect changes made elsewhere (e.g. the popup) unless the user is editing.
  if (area === "local" && changes[SETTINGS_KEY] && dirtyNote.hidden) {
    applyToForm(migrateSettings({ [SETTINGS_KEY]: changes[SETTINGS_KEY].newValue }).settings);
  }
});

// ── Engine status ─────────────────────────────────────────────────────────

async function refreshStatus(): Promise<void> {
  try {
    const status = (await chrome.runtime.sendMessage({ type: "ui:status" })) as UiStatusReply;
    engineStatusEl.dataset.state = status.engine.state;
    engineStatusEl.textContent = !saved?.enabled ? "Filtering off" : describeEngine(status.engine);
    const rows: [string, string][] = [
      ["Engine", status.engine.state],
      ["Backend", status.engine.backend ?? "—"],
      ["Model", status.engine.model],
      ["Load time", status.engine.loadMs === null ? "—" : `${status.engine.loadMs} ms`],
      ["Detail", status.engine.detail ?? "—"],
      ["Content script", status.registration.registered ? "registered" : "not registered"],
      ["Registration error", status.registration.error ?? "—"],
    ];
    diagnostics.replaceChildren(
      ...rows.flatMap(([k, v]) => [
        Object.assign(document.createElement("dt"), { textContent: k }),
        Object.assign(document.createElement("dd"), { textContent: v }),
      ])
    );
  } catch {
    engineStatusEl.textContent = "Status unavailable";
  }
}

// ── Migration notes ───────────────────────────────────────────────────────

const migrationBox = $<HTMLElement>("migration-notes");
chrome.storage.local.get(MIGRATION_NOTES_KEY).then((r) => {
  const notes = r[MIGRATION_NOTES_KEY] as { droppedSites?: { input: string; error: string }[] } | undefined;
  const dropped = Array.isArray(notes?.droppedSites) ? notes!.droppedSites : [];
  if (!dropped.length) return;
  $<HTMLUListElement>("migration-list").replaceChildren(
    ...dropped.map((d) => Object.assign(document.createElement("li"), { textContent: `${String(d.input)} — ${String(d.error)}` }))
  );
  migrationBox.hidden = false;
});
$<HTMLButtonElement>("dismiss-migration").addEventListener("click", async () => {
  await chrome.storage.local.remove(MIGRATION_NOTES_KEY);
  migrationBox.hidden = true;
});

chrome.storage.local.get([...STORAGE_KEYS]).then((stored) => {
  applyToForm(migrateSettings(stored).settings);
  void refreshStatus();
});
setInterval(refreshStatus, 3000);
