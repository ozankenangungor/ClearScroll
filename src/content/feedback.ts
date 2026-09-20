/** A temporary, explicitly opened picker. No persistent per-item controls. */
import type { Settings } from "../shared/settings.ts";
import { activeTopics } from "../shared/settings.ts";
import type { FeedbackDraft } from "../shared/feedback.ts";
import type { FilterController } from "./controller.ts";

export function openFeedback(controller: FilterController, settings: Settings, save: (draft: FeedbackDraft) => Promise<{ ok: boolean }>): () => void {
  const previous = document.activeElement;
  const host = document.createElement("div");
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-label", "ClearScroll local text feedback");
  host.style.cssText = "all:initial!important;position:fixed!important;inset:auto 12px 12px!important;z-index:2147483647!important;display:block!important;filter:none!important";
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host{color-scheme:light}section{font:16px/1.5 system-ui;background:#fff;color:#171717;border:2px solid #555;border-radius:8px;padding:14px;box-shadow:0 2px 14px #0006;max-height:45vh;overflow:auto}
    button,select{font:inherit;color:#171717;background:#fff;border:1px solid #555;border-radius:4px;padding:5px 10px;margin:4px}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #195cc6;outline-offset:2px}button:disabled{opacity:.6}p{margin:4px}label{display:block}#outline{position:fixed;pointer-events:none;border:3px solid #195cc6;background:#195cc612;box-sizing:border-box}
    `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `<div id="outline" hidden></div><section><strong>Local text feedback</strong>
    <p>Click a text item, or use Previous / Next and Choose. Escape cancels. No page text or addresses are saved.</p>
    <button id="prev">Previous item</button><button id="next">Next item</button><button id="choose">Choose item</button>
    <p id="status" role="status" aria-live="polite">Choose an item to report.</p>
    <label>Enabled topic <select id="topic"></select></label>
    <label><input type="checkbox" id="diagnostics"> Include local diagnostics (tag-only DOM path and best-topic decision scores)</label>
    <button id="save" disabled>Save feedback locally</button><button id="cancel">Close</button></section>`;
  const $ = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  const select = $<HTMLSelectElement>("topic");
  for (const t of activeTopics(settings)) select.add(new Option(t.text, t.id));
  const units = controller.feedbackUnits();
  let index = -1;
  let candidate: Element | null = null;
  let selected: Element | null = null;
  let closed = false;
  const status = $("status");
  const saveButton = $<HTMLButtonElement>("save");
  const paint = () => {
    const r = candidate?.getBoundingClientRect();
    const outline = $("outline");
    outline.hidden = !r;
    if (r) Object.assign(outline.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  };
  const choose = (u: Element | null) => {
    selected = u;
    candidate = u;
    const draft = u && controller.feedbackDraft(u, select.value, false);
    saveButton.disabled = !draft;
    status.textContent = draft ? `${draft.kind === "wrongly-hidden" ? "Wrongly hidden" : "Should be hidden"}: ${draft.target.tag} item ${draft.target.ordinal}. Check the topic, then save.` : "This area is protected or unavailable. Choose a public text item.";
    paint();
    if (draft) select.focus();
  };
  const move = (step: number) => {
    if (!units.length) { status.textContent = "No eligible text items. Close and try another page."; return; }
    index = (index + step + units.length) % units.length;
    candidate = units[index]!;
    candidate.scrollIntoView({ block: "center", behavior: "instant" });
    status.textContent = `Item ${index + 1} of ${units.length}. Choose to report this highlighted item.`;
    selected = null;
    saveButton.disabled = true;
    paint();
  };
  const click = (e: MouseEvent) => {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    choose(e.target instanceof Element ? controller.feedbackUnit(e.target) : null);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (!e.composedPath().includes(host) && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault(); e.stopImmediatePropagation();
      choose(e.target instanceof Element ? controller.feedbackUnit(e.target) : null);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("click", click, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("scroll", paint, true);
    window.removeEventListener("resize", paint);
    clearTimeout(timer);
    host.remove();
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  };
  $("prev").onclick = () => move(-1);
  $("next").onclick = () => move(1);
  $("choose").onclick = () => choose(candidate);
  $("cancel").onclick = close;
  saveButton.onclick = async () => {
    const draft = selected && controller.feedbackDraft(selected, select.value, $<HTMLInputElement>("diagnostics").checked);
    if (!draft) { choose(null); return; }
    saveButton.disabled = true;
    try {
      const result = await save(draft);
      if (!result?.ok) throw Error("save failed");
      status.textContent = "Saved on this device. Review, export or delete in Settings. Feedback does not change filtering.";
      selected = null;
    } catch {
      status.textContent = "Could not save. Check settings or reload this page and try again.";
      saveButton.disabled = false;
    }
  };
  // Window capture precedes the controller's document handlers: picking never reveals or follows links.
  window.addEventListener("click", click, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("scroll", paint, true);
  window.addEventListener("resize", paint);
  const timer = setTimeout(close, 120_000);
  document.body.append(host);
  $("next").focus();
  return close;
}
