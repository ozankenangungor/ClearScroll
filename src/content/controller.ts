/**
 * FilterController — content-script state machine.
 *
 *   stopped ──applySettings(active)──▶ active ──applySettings(inactive)──▶ stopped
 *                                     ▲    │ settings change: generation++ and rescan
 *                                     └────┘
 *
 * Correctness rules for applying a verdict (all must hold):
 *   1. reply.generation === current generation (config unchanged since send)
 *   2. the controller is still active (not paused / excluded / torn down)
 *   3. the element is still connected to the document
 *   4. the element's current text equals the text that was classified
 * Anything else is dropped; changed elements are already queued again.
 *
 * Work is bounded: only units near the viewport (IntersectionObserver) are
 * queued, the queue is de-duplicated and capped, batches are small, and at
 * most MAX_INFLIGHT requests are outstanding per frame (backpressure).
 */

import { decide, LEXICAL_PARAMS, prepareTopic } from "../shared/classifier.ts";
import type { ClassifyReply, ClassifyRequest, EngineStatus, TabActivity, TabStateReply } from "../shared/protocol.ts";
import { activeTopics, type Settings } from "../shared/settings.ts";
import { isUrlExcluded } from "../shared/sites.ts";
import {
  OWNER_ATTR,
  STATE_ATTR,
  applyBlur,
  clearAllVisuals,
  clearVisual,
  collectUnits,
  compileProtectedSelector,
  itemOf,
  markRevealed,
  unitOf,
  unitText,
  visualState,
} from "./dom.ts";

export const BATCH_SIZE = 24;
/** First request after (re)configuration is small so on-screen content is handled sooner. */
export const FIRST_BATCH_SIZE = 8;
export const MAX_INFLIGHT = 2;
export const MAX_QUEUE = 1000;
const FLUSH_DELAY_MS = 60;
const MAX_FLUSH_WAIT_MS = 400;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 30_000;

export interface ControllerDeps {
  doc: Document;
  classify(req: ClassifyRequest): Promise<ClassifyReply>;
  /** Called when the extension context is gone (update/uninstall). */
  onInvalidated?(): void;
  /** Root margin for "near the viewport". */
  rootMargin?: string;
}

interface UnitState {
  /** Text of the most recent classification request or verdict. */
  text: string;
  generation: number;
  phase: "dirty" | "queued" | "inflight" | "done";
  /** Text the user chose to reveal; stays revealed until the text changes. */
  revealedText: string | null;
  /** Element showing this unit's match: the unit itself or its feed item. */
  target: Element | null;
}

export class FilterController {
  private settings: Settings | null = null;
  private activity: TabActivity = "stopped";
  private generation = 0;
  private protectedSelector = "";
  private states = new WeakMap<Element, UnitState>();
  /** Hidden feed items → their matched units; an item is shown while any member matches. */
  private items = new WeakMap<Element, Set<Element>>();
  private nearViewport = new WeakSet<Element>();
  private observed = new WeakSet<Element>();
  private readonly queue = new Set<Element>();
  private inflight = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstPendingAt = 0;
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private lastEngine: EngineStatus | null = null;
  private analyzed = 0;
  private sentInGeneration = -1;
  private retryDelay = RETRY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly retryUnits = new Set<Element>();
  private readonly onClick = (e: MouseEvent) => this.handleClick(e);
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKey(e);

  private readonly deps: ControllerDeps;
  /** Tags the elements this instance changes (see clearAllVisuals). */
  readonly instanceId = `cs${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** Apply (new) settings for the page at `url`. Idempotent. */
  applySettings(settings: Settings, url: string): void {
    this.settings = settings;
    const next: TabActivity = !settings.enabled
      ? "paused"
      : activeTopics(settings).length === 0
        ? "no-topics"
        : isUrlExcluded(url, settings.excludedSites)
          ? "excluded"
          : "active";

    this.generation++;
    if (next !== "active") {
      this.stop(next);
      return;
    }
    this.protectedSelector = compileProtectedSelector(settings.protectedSelectors, this.deps.doc);
    if (this.activity !== "active") this.start();
    this.activity = "active";
    this.rescan();
  }

  /** Remove every trace of filtering from the page. */
  stop(activity: TabActivity = "stopped"): void {
    this.activity = activity;
    this.generation++;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.deps.doc.removeEventListener("click", this.onClick, true);
    this.deps.doc.removeEventListener("keydown", this.onKeyDown, true);
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryUnits.clear();
    this.queue.clear();
    this.states = new WeakMap();
    this.items = new WeakMap();
    this.nearViewport = new WeakSet();
    this.observed = new WeakSet();
    clearAllVisuals(this.deps.doc, this.instanceId);
  }

  getState(): TabStateReply {
    const doc = this.deps.doc;
    return {
      activity: this.activity,
      blurred: doc.querySelectorAll(`[${STATE_ATTR}="blurred"]`).length,
      revealed: doc.querySelectorAll(`[${STATE_ATTR}="revealed"]`).length,
      analyzed: this.analyzed,
      engine: this.lastEngine,
    };
  }

  private start(): void {
    const doc = this.deps.doc;
    const view = doc.defaultView!;
    this.intersectionObserver = new view.IntersectionObserver((entries) => this.onIntersect(entries), {
      rootMargin: this.deps.rootMargin ?? "150% 0px",
    });
    this.mutationObserver = new view.MutationObserver((records) => this.onMutations(records));
    this.mutationObserver.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    doc.addEventListener("click", this.onClick, true);
    doc.addEventListener("keydown", this.onKeyDown, true);
  }

  private rescan(): void {
    const body = this.deps.doc.body;
    if (!body) return;
    const units = new Set<Element>();
    collectUnits(body, this.protectedSelector, units);
    for (const u of units) this.touch(u);
    // Units that were blurred but are no longer candidates (e.g. a selector
    // became protected) must not stay blurred with a stale verdict. Items
    // are cleared through their members (touch → hide).
    this.deps.doc.querySelectorAll(`[${STATE_ATTR}]`).forEach((el) => {
      if (!units.has(el) && !this.items.has(el)) clearVisual(el);
    });
    this.scheduleFlush();
  }

  /** (Re)evaluate whether a unit needs classification. */
  private touch(unit: Element): void {
    if (this.activity !== "active") return;
    const text = unitText(unit, this.protectedSelector);
    const st = this.states.get(unit);
    if (text === null) {
      if (st) this.hide(unit, st);
      // A hidden item is not a unit itself; it is cleared through its members.
      if (visualState(unit) && !this.items.has(unit)) clearVisual(unit);
      return;
    }
    if (st && st.text === text && st.generation === this.generation && st.phase !== "dirty") return;
    this.states.set(unit, { text, generation: this.generation, phase: "dirty", revealedText: st?.revealedText ?? null, target: st?.target ?? null });
    if (!this.observed.has(unit)) {
      this.observed.add(unit);
      this.intersectionObserver?.observe(unit);
      // Background tabs do not render, so IntersectionObserver never fires
      // there. Use layout geometry instead so a page opened in the background
      // is already filtered when the user switches to it.
      if (this.deps.doc.visibilityState === "hidden" && this.isNearViewportByLayout(unit)) {
        this.nearViewport.add(unit);
        this.enqueue(unit);
      }
    } else if (this.nearViewport.has(unit)) {
      this.enqueue(unit);
    }
  }

  /** Same margin as the IntersectionObserver: 1.5 viewports above and below. */
  private isNearViewportByLayout(unit: Element): boolean {
    const view = this.deps.doc.defaultView!;
    const r = unit.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const margin = view.innerHeight * 1.5;
    return r.bottom >= -margin && r.top <= view.innerHeight + margin;
  }

  private enqueue(unit: Element): void {
    const st = this.states.get(unit);
    if (!st || st.phase !== "dirty") return;
    st.phase = "queued";
    this.queue.add(unit);
    if (this.queue.size > MAX_QUEUE) {
      const oldest = this.queue.values().next().value as Element;
      this.queue.delete(oldest);
      const s = this.states.get(oldest);
      if (s) s.phase = "dirty"; // re-queued when it next intersects or changes
    }
    this.scheduleFlush();
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (e.isIntersecting) {
        this.nearViewport.add(e.target);
        this.enqueue(e.target);
      } else {
        this.nearViewport.delete(e.target);
      }
    }
  }

  private onMutations(records: MutationRecord[]): void {
    if (this.activity !== "active") return;
    const touched = new Set<Element>();
    for (const r of records) {
      if (r.type === "characterData") {
        const u = unitOf(r.target);
        if (u) touched.add(u);
        continue;
      }
      const u = unitOf(r.target);
      if (u) touched.add(u);
      r.addedNodes.forEach((n) => {
        if (n.nodeType === Node.ELEMENT_NODE) collectUnits(n, this.protectedSelector, touched);
        else if (n.nodeType === Node.TEXT_NODE) {
          const tu = unitOf(n);
          if (tu) touched.add(tu);
        }
      });
    }
    for (const u of touched) this.touch(u);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.queue.size === 0) return;
    const now = Date.now();
    if (this.flushTimer === null) {
      this.firstPendingAt = now;
    } else {
      // The first request of a configuration is not postponed: on a page that
      // keeps rendering, the debounce would hold it back for MAX_FLUSH_WAIT_MS
      // while matching content is visible. Later requests are batched as before.
      if (this.sentInGeneration !== this.generation) return;
      clearTimeout(this.flushTimer);
    }
    const delay = now - this.firstPendingAt >= MAX_FLUSH_WAIT_MS ? 0 : FLUSH_DELAY_MS;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  }

  private flush(): void {
    while (this.inflight < MAX_INFLIGHT && this.queue.size > 0) {
      const units: Element[] = [];
      const texts: string[] = [];
      const limit = this.sentInGeneration === this.generation ? BATCH_SIZE : FIRST_BATCH_SIZE;
      this.sentInGeneration = this.generation;
      for (const u of this.queue) {
        this.queue.delete(u);
        const st = this.states.get(u);
        if (!st || st.phase !== "queued") continue;
        if (!u.isConnected) {
          // Detached (e.g. a virtualised list recycled it). Back to the pool so
          // it is classified if the same node is re-attached.
          st.phase = "dirty";
          continue;
        }
        st.phase = "inflight";
        units.push(u);
        texts.push(st.text);
        if (units.length >= limit) break;
      }
      if (units.length === 0) return;
      void this.send(units, texts);
    }
  }

  private async send(units: Element[], texts: string[]): Promise<void> {
    const settings = this.settings!;
    const generation = this.generation;
    const req: ClassifyRequest = {
      type: "cs:classify",
      generation,
      mode: settings.mode,
      topics: activeTopics(settings).map((t) => ({ id: t.id, text: t.text })),
      texts,
    };
    this.inflight++;
    let reply: ClassifyReply;
    let provisional = false;
    try {
      reply = await this.deps.classify(req);
    } catch (err) {
      if (/context invalidated/i.test(String(err))) {
        this.inflight--;
        this.stop();
        this.deps.onInvalidated?.();
        return;
      }
      // Messaging failed (service worker restarting, port closed, …). Apply
      // keyword verdicts now, but treat them as provisional and retry.
      reply = this.localFallback(req, err);
      provisional = true;
    }
    this.inflight--;
    if (reply.engine) this.lastEngine = reply.engine;

    if (reply.ok && reply.decisions.length === units.length) {
      this.apply(units, texts, generation, reply);
      if (provisional) {
        for (const u of units) {
          const st = this.states.get(u);
          if (st && st.generation === this.generation && st.phase === "done") {
            st.phase = "dirty";
            this.retryUnits.add(u);
          }
        }
        this.scheduleRetry(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
      } else {
        this.retryDelay = RETRY_MIN_MS;
      }
    } else {
      const stale = !reply.ok && reply.stale;
      if (!stale) console.warn("[ClearScroll] classify failed:", reply.ok ? "length mismatch" : reply.error);
      // Return still-current units to the dirty pool and retry them (with
      // backoff for real failures). IntersectionObserver will not fire again
      // for units that are already on screen, so without this they would
      // never be classified.
      for (const u of units) {
        const st = this.states.get(u);
        if (st && st.generation === this.generation && st.phase === "inflight") {
          st.phase = "dirty";
          this.retryUnits.add(u);
        }
      }
      this.scheduleRetry(stale ? 0 : this.retryDelay);
      if (!stale) this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    }
    if (this.activity === "active") this.flush();
  }

  private scheduleRetry(delay: number): void {
    if (this.retryTimer !== null || this.retryUnits.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      for (const u of this.retryUnits) {
        if (this.nearViewport.has(u) && u.isConnected) this.enqueue(u);
      }
      this.retryUnits.clear();
    }, delay);
  }

  /** Keyword-only verdicts when the background/engine cannot be reached. */
  private localFallback(req: ClassifyRequest, err: unknown): ClassifyReply {
    const params = { threshold: Infinity, minSemanticChars: Infinity, lexical: LEXICAL_PARAMS[req.mode] };
    const topics = req.topics.map((t) => prepareTopic(t, null, params));
    return {
      ok: true,
      generation: req.generation,
      decisions: decide(req.texts, null, 0, topics, params),
      engine: {
        state: "lexical-fallback",
        backend: null,
        model: this.lastEngine?.model ?? "unknown",
        detail: `engine unreachable: ${String(err)}`,
        loadMs: null,
        updatedAt: Date.now(),
      },
    };
  }

  private apply(units: Element[], texts: string[], generation: number, reply: Extract<ClassifyReply, { ok: true }>): void {
    if (generation !== this.generation || this.activity !== "active") return;
    units.forEach((u, i) => {
      const st = this.states.get(u);
      if (!st || st.text !== texts[i] || st.generation !== generation) return;
      if (!u.isConnected) {
        // Verdict for a detached node: keep it classifiable if re-attached.
        if (st.phase === "inflight") st.phase = "dirty";
        return;
      }
      st.phase = "done";
      this.analyzed++;
      if (reply.decisions[i]!.matched) this.show(u, st);
      else this.hide(u, st);
    });
  }

  /** Show a matched unit as hidden — through its feed item when it has one. */
  private show(unit: Element, st: UnitState): void {
    const target = this.targetFor(unit);
    if (st.target !== target) this.hide(unit, st);
    st.target = target;
    if (target === unit) {
      if (st.revealedText === st.text) {
        markRevealed(unit, this.instanceId);
      } else {
        st.revealedText = null;
        applyBlur(unit, this.instanceId);
      }
      return;
    }
    let members = this.items.get(target);
    if (!members) this.items.set(target, (members = new Set()));
    members.add(unit);
    this.absorb(target, members);
    this.renderItem(target, members);
  }

  /** The unit no longer matches (or is no longer a candidate). */
  private hide(unit: Element, st: UnitState): void {
    const target = st.target;
    st.target = null;
    if (target === unit) clearVisual(unit);
    else if (target) this.leaveItem(target, unit);
    // Its item may still count members a re-render detached; prune them.
    const item = this.itemContaining(unit);
    if (item) this.leaveItem(item, unit);
  }

  private targetFor(unit: Element): Element {
    const own = itemOf(unit, this.protectedSelector) ?? unit;
    // Never nest hidden elements (two reveals): join an enclosing hidden item.
    return this.itemContaining(own) ?? own;
  }

  private itemContaining(el: Element): Element | null {
    for (let a = el.parentElement; a; a = a.parentElement) if (this.items.has(a)) return a;
    return null;
  }

  /** Move units or smaller items hidden inside `item` into it. */
  private absorb(item: Element, members: Set<Element>): void {
    for (const el of item.querySelectorAll(`[${OWNER_ATTR}="${CSS.escape(this.instanceId)}"]`)) {
      const inner = this.items.get(el);
      if (inner) {
        for (const m of inner) {
          members.add(m);
          const s = this.states.get(m);
          if (s) s.target = item;
        }
        this.items.delete(el);
        clearVisual(el);
      } else {
        const s = this.states.get(el);
        if (s?.target === el) {
          s.target = item;
          members.add(el);
          clearVisual(el);
        }
      }
    }
  }

  private leaveItem(item: Element, unit: Element): void {
    const members = this.items.get(item);
    if (!members) return;
    members.delete(unit);
    for (const m of members) if (!m.isConnected || !item.contains(m)) members.delete(m);
    if (members.size > 0) {
      this.renderItem(item, members);
    } else {
      this.items.delete(item);
      clearVisual(item);
    }
  }

  /** An item stays revealed while any member is revealed for its current text. */
  private renderItem(item: Element, members: Set<Element>): void {
    const revealed = [...members].some((m) => {
      const s = this.states.get(m);
      return !!s && s.revealedText === s.text;
    });
    if (revealed) markRevealed(item, this.instanceId);
    else applyBlur(item, this.instanceId);
  }

  private blurredTarget(target: EventTarget | null): Element | null {
    const el = target instanceof Element ? target : null;
    return el?.closest(`[${STATE_ATTR}="blurred"]`) ?? null;
  }

  /** Reveal a hidden unit or item (all of the item's members). */
  private reveal(el: Element): void {
    for (const u of this.items.get(el) ?? [el]) {
      const st = this.states.get(u);
      if (st) st.revealedText = st.text;
    }
    markRevealed(el, this.instanceId);
  }

  private handleClick(e: MouseEvent): void {
    const unit = this.blurredTarget(e.target);
    if (!unit) return;
    // First click only reveals; it must not activate links/handlers underneath.
    e.preventDefault();
    e.stopImmediatePropagation();
    this.reveal(unit);
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== " ") return;
    const unit = this.blurredTarget(e.target);
    if (!unit || unit !== e.target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.reveal(unit);
  }
}
