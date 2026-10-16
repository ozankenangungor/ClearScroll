/**
 * ImageFilter — the image half of the content script, owned and driven by
 * FilterController (same generation, settings, observers and reveal clicks).
 *
 * Per media element:
 *
 *   discovered ─▶ waiting (not loaded yet; resumes on its load event)
 *              ─▶ dirty ─near viewport─▶ queued ─▶ inflight ─▶ done (matched or not)
 *                                                          └─▶ skipped (cannot be analysed)
 *
 * A verdict is applied only if (1) its generation is current, (2) image
 * filtering is still active, (3) the element is connected and (4) it still
 * shows the same image (identity = kind + URL). A changed src/srcset/poster/
 * style or a load event re-evaluates the element; stale replies are dropped.
 *
 * Pixels are read in the page whenever the browser allows it (no network).
 * Only if they are not readable (cross-origin without CORS) and the user
 * allowed downloads is the URL sent instead. Otherwise the image is skipped
 * and counted ("cross-origin"); it is never guessed from text.
 *
 * Bounded work: candidates near the viewport only (IntersectionObserver),
 * visible ones first, at most MAX_INFLIGHT requests and MAX_QUEUE queued per
 * frame, one request per image identity at a time; repeated identities reuse
 * the verdict of the current generation.
 */

import type { TopicSnapshot } from "../shared/protocol.ts";
import { activeTopics, type Settings } from "../shared/settings.ts";
import type { SkipReason, TabImageState, VisionDecision, VisionReply, VisionRequest, VisionStatus } from "../shared/vision.ts";
import { bytesToBase64 } from "../vision/preprocess.ts";
import { LruCache } from "../offscreen/lru.ts";
import { MEDIA_ATTR, OWNER_ATTR, STATE_ATTR, applyBlur, clearVisual, markRevealed, visualState } from "./dom.ts";
import { PixelsUnavailable, collectMedia, isLocalImageUrl, mediaInfo, readPixels } from "./media.ts";

export const IMAGE_MAX_INFLIGHT = 2;
export const IMAGE_MAX_QUEUE = 200;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 60_000;
const VERDICT_CACHE = 2000;
/** Look-ahead in viewport heights above and below: pictures this close to the viewport are analysed. */
export const IMAGE_LOOKAHEAD = 0.5;
/** Re-check interval for near-viewport pictures still loading, hidden or fading in. */
const WAITING_RECHECK_MS = 1000;
/** At most this many waiting pictures are re-checked per round. */
const WAITING_RECHECK_MAX = 300;
/** Reasons that will not change for the same image and settings. */
const PERMANENT: ReadonlySet<SkipReason> = new Set(["cross-origin", "downloads-off", "ineligible-url", "decode", "too-large", "download-failed", "disabled"]);

export interface ImageFilterDeps {
  doc: Document;
  classifyImage(req: VisionRequest): Promise<VisionReply>;
  owner: string;
  rootMargin?: string;
}

interface MediaState {
  identity: string;
  generation: number;
  phase: "waiting" | "dirty" | "queued" | "inflight" | "done" | "skipped";
  matched: boolean;
  /** Identity the user revealed; stays revealed until the image changes. */
  revealedIdentity: string | null;
  attempts: number;
}

export class ImageFilter {
  private active = false;
  private settings: Settings | null = null;
  private generation = 0;
  private protectedSelector = "";
  private states = new WeakMap<Element, MediaState>();
  private tracked = new Set<Element>();
  private near = new WeakSet<Element>();
  private observed = new WeakSet<Element>();
  private readonly queue = new Set<Element>();
  private inflight = 0;
  /** identity → verdict for the current generation (shared images). */
  private verdicts = new LruCache<string, VisionDecision>(VERDICT_CACHE);
  /** identity → elements waiting for an in-flight request. */
  private waiting = new Map<string, Set<Element>>();
  private observer: IntersectionObserver | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private waitingTimer: ReturnType<typeof setInterval> | null = null;
  private retryDelay = RETRY_MIN_MS;
  private readonly retry = new Set<Element>();
  private lastVision: VisionStatus | null = null;
  private analyzed = 0;
  private skipped: Partial<Record<SkipReason, number>> = {};
  private readonly onLoad = (e: Event) => {
    const t = e.target;
    if (t instanceof Element && t.tagName === "IMG") {
      this.touch(t);
      this.flush();
    }
  };
  /** A fade-in finished: pictures that were transparent are re-checked. */
  private readonly onTransitionEnd = (e: Event) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    let any = false;
    for (const el of this.tracked) {
      if ((el === t || t.contains(el)) && this.states.get(el)?.phase === "waiting") {
        this.touch(el);
        any = true;
      }
    }
    if (any) this.flush();
  };
  private readonly deps: ImageFilterDeps;

  constructor(deps: ImageFilterDeps) {
    this.deps = deps;
  }

  /** (Re)configure for a new generation; inactive → remove all image effects. */
  configure(settings: Settings, generation: number, protectedSelector: string, active: boolean): void {
    this.generation = generation;
    if (!active || !settings.images) {
      this.stop();
      return;
    }
    this.settings = settings;
    this.protectedSelector = protectedSelector;
    this.verdicts = new LruCache(VERDICT_CACHE);
    this.waiting = new Map();
    this.skipped = {};
    this.retry.clear();
    this.retryDelay = RETRY_MIN_MS;
    if (!this.active) this.start();
    this.active = true;
    this.rescan();
  }

  stop(): void {
    this.active = false;
    this.observer?.disconnect();
    this.observer = null;
    this.deps.doc.removeEventListener("load", this.onLoad, true);
    this.deps.doc.removeEventListener("transitionend", this.onTransitionEnd, true);
    this.deps.doc.removeEventListener("animationend", this.onTransitionEnd, true);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.waitingTimer !== null) clearInterval(this.waitingTimer);
    this.waitingTimer = null;
    this.retry.clear();
    this.queue.clear();
    this.waiting = new Map();
    this.deps.doc.querySelectorAll(`[${MEDIA_ATTR}][${OWNER_ATTR}="${CSS.escape(this.deps.owner)}"]`).forEach(clearMedia);
    this.states = new WeakMap();
    this.tracked = new Set();
    this.near = new WeakSet();
    this.observed = new WeakSet();
  }

  getState(): TabImageState {
    let blurred = 0;
    let waiting = 0;
    for (const el of this.tracked) {
      if (el.isConnected && visualState(el) === "blurred") blurred++;
      if (this.states.get(el)?.phase === "waiting") waiting++;
    }
    return { enabled: this.active, analyzed: this.analyzed, blurred, skipped: { ...this.skipped }, pipeline: { tracked: this.tracked.size, waiting, queued: this.queue.size, inflight: this.inflight }, vision: this.lastVision };
  }

  isMedia(el: Element): boolean {
    return this.tracked.has(el);
  }

  private start(): void {
    const view = this.deps.doc.defaultView!;
    // Images are expensive: a shorter look-ahead than text (half a viewport).
    this.observer = new view.IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: this.deps.rootMargin ?? `${IMAGE_LOOKAHEAD * 100}% 0px` });
    this.deps.doc.addEventListener("load", this.onLoad, true);
    this.deps.doc.addEventListener("transitionend", this.onTransitionEnd, true);
    this.deps.doc.addEventListener("animationend", this.onTransitionEnd, true);
  }

  private rescan(): void {
    const body = this.deps.doc.body;
    if (!body) return;
    const found = new Set<Element>();
    collectMedia(body, found);
    for (const el of this.tracked) if (!found.has(el)) this.touch(el);
    for (const el of found) this.touch(el);
    this.flush();
  }

  /** New nodes and changed image attributes (from the controller's MutationObserver). */
  onMutations(records: MutationRecord[]): void {
    if (!this.active) return;
    const touched = new Set<Element>();
    for (const r of records) {
      if (r.type === "attributes") {
        const el = r.target as Element;
        if (this.tracked.has(el) || el.matches?.("img, video[poster], [style*='background'], [role='img']")) touched.add(el);
        // A <source srcset> change switches its <picture>'s image.
        if (el.tagName === "SOURCE" && el.parentElement?.tagName === "PICTURE") el.parentElement.querySelectorAll("img").forEach((i) => touched.add(i));
      } else {
        r.addedNodes.forEach((n) => collectMedia(n, touched));
      }
    }
    for (const el of touched) this.touch(el);
    this.flush();
  }

  /** (Re)evaluate one element. */
  touch(el: Element): void {
    if (!this.active) return;
    const info = mediaInfo(el, this.protectedSelector);
    const st = this.states.get(el);
    if (!info.ok) {
      if (info.reason === "pending") {
        // Not loaded yet, or transparent (fading in): the capture-phase load /
        // transitionend / animationend listeners or the observer bring it back.
        this.track(el);
        this.states.set(el, { identity: "", generation: this.generation, phase: "waiting", matched: false, revealedIdentity: st?.revealedIdentity ?? null, attempts: 0 });
        this.watchWaiting();
      } else if (st) {
        this.states.delete(el);
        this.tracked.delete(el);
        clearMedia(el);
      }
      return;
    }
    if (st && st.identity === info.identity && st.generation === this.generation && st.phase !== "dirty" && st.phase !== "waiting") return;
    const changed = !st || st.identity !== info.identity;
    if (changed && st?.matched) clearMedia(el);
    this.track(el);
    const next: MediaState = { identity: info.identity, generation: this.generation, phase: "dirty", matched: false, revealedIdentity: st?.revealedIdentity === info.identity ? info.identity : null, attempts: 0 };
    this.states.set(el, next);
    if (!changed && st?.matched && st.generation !== this.generation) {
      // Same image, new settings: keep showing the old verdict until the new one arrives.
      next.matched = true;
    }
    const known = this.verdicts.get(info.identity);
    if (known) {
      this.finish(el, next, known);
      return;
    }
    if (this.near.has(el) || this.isNearByLayout(el)) {
      this.near.add(el);
      this.enqueue(el);
    }
  }

  /**
   * Fallback for pictures that finish loading, appear or fade in without an
   * event we see (a class switch without a transition, a parent becoming
   * visible): while any tracked picture is waiting, re-check those near the
   * viewport once a second.
   */
  private watchWaiting(): void {
    if (this.waitingTimer !== null) return;
    this.waitingTimer = setInterval(() => {
      let left = 0;
      const h = this.deps.doc.defaultView!.innerHeight;
      for (const el of this.tracked) {
        if (this.states.get(el)?.phase !== "waiting") continue;
        if (!el.isConnected) {
          this.tracked.delete(el);
          continue;
        }
        if (++left > WAITING_RECHECK_MAX) break;
        // Layout position, not the observer: a picture that was 0 × 0 when
        // observed gets no new intersection entry when it grows.
        const r = el.getBoundingClientRect();
        if (r.bottom >= -h * IMAGE_LOOKAHEAD && r.top <= h * (1 + IMAGE_LOOKAHEAD)) {
          this.near.add(el);
          this.touch(el);
        }
      }
      this.flush();
      if (left === 0 || !this.active) {
        clearInterval(this.waitingTimer!);
        this.waitingTimer = null;
      }
    }, WAITING_RECHECK_MS);
  }

  private track(el: Element): void {
    this.tracked.add(el);
    if (!this.observed.has(el)) {
      this.observed.add(el);
      this.observer?.observe(el);
    }
  }

  /** Same margin as the observer, for background tabs where it never fires. */
  private isNearByLayout(el: Element): boolean {
    if (this.deps.doc.visibilityState !== "hidden") return false;
    const h = this.deps.doc.defaultView!.innerHeight;
    const r = el.getBoundingClientRect();
    return r.bottom >= -h * IMAGE_LOOKAHEAD && r.top <= h * (1 + IMAGE_LOOKAHEAD);
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      if (e.isIntersecting) {
        this.near.add(e.target);
        const st = this.states.get(e.target);
        if (!st || st.phase === "dirty" || st.phase === "waiting") this.touch(e.target);
        this.enqueue(e.target);
      } else {
        this.near.delete(e.target);
      }
    }
    this.flush();
  }

  private enqueue(el: Element): void {
    const st = this.states.get(el);
    if (!st || st.phase !== "dirty") return;
    st.phase = "queued";
    this.queue.add(el);
    if (this.queue.size > IMAGE_MAX_QUEUE) {
      const oldest = this.queue.values().next().value as Element;
      this.queue.delete(oldest);
      const s = this.states.get(oldest);
      if (s) s.phase = "dirty";
    }
  }

  /** Next element to analyse: on screen first, then nearest to the viewport. */
  private pick(): Element | null {
    const h = this.deps.doc.defaultView!.innerHeight;
    let best: Element | null = null;
    let bestDist = Infinity;
    for (const el of this.queue) {
      const st = this.states.get(el);
      if (!st || st.phase !== "queued" || !el.isConnected) {
        this.queue.delete(el);
        if (st && st.phase === "queued") st.phase = "dirty";
        continue;
      }
      const r = el.getBoundingClientRect();
      const dist = r.bottom < 0 ? -r.bottom : r.top > h ? r.top - h : 0;
      if (dist < bestDist) {
        best = el;
        bestDist = dist;
        if (dist === 0) break;
      }
    }
    if (best) this.queue.delete(best);
    return best;
  }

  private flush(): void {
    while (this.active && this.inflight < IMAGE_MAX_INFLIGHT && this.queue.size > 0) {
      const el = this.pick();
      if (!el) return;
      const st = this.states.get(el)!;
      const known = this.verdicts.get(st.identity);
      if (known) {
        this.finish(el, st, known);
        continue;
      }
      const group = this.waiting.get(st.identity);
      st.phase = "inflight";
      if (group) {
        group.add(el); // the same image is already being analysed
        continue;
      }
      this.waiting.set(st.identity, new Set([el]));
      void this.send(el, st);
    }
  }

  private async send(el: Element, st: MediaState): Promise<void> {
    const generation = this.generation;
    const settings = this.settings!;
    const identity = st.identity;
    this.inflight++;
    let reply: VisionReply;
    try {
      const image = await this.imagePayload(el);
      const req: VisionRequest = {
        type: "cs:vision",
        generation,
        mode: settings.mode,
        topics: activeTopics(settings).map((t): TopicSnapshot => ({ id: t.id, text: t.text })),
        image,
      };
      reply = await this.deps.classifyImage(req);
    } catch (err) {
      if (/context invalidated/i.test(String(err))) {
        this.inflight--;
        this.stop();
        return;
      }
      const reason: SkipReason = err instanceof Skipped ? err.reason : err instanceof PixelsUnavailable ? "cross-origin" : "unavailable";
      reply = { ok: false, generation, reason, error: String(err), vision: null };
    }
    this.inflight--;
    if (reply.vision) this.lastVision = reply.vision;
    const group = this.waiting.get(identity) ?? new Set([el]);
    this.waiting.delete(identity);
    if (generation !== this.generation || !this.active) return;

    if (reply.ok) {
      this.verdicts.set(identity, reply.decision);
      this.retryDelay = RETRY_MIN_MS;
      for (const m of group) {
        const s = this.states.get(m);
        if (s && s.identity === identity && s.generation === generation && s.phase === "inflight" && m.isConnected) this.finish(m, s, reply.decision);
        else if (s && s.phase === "inflight") s.phase = "dirty";
      }
    } else if (reply.reason === "stale" || !PERMANENT.has(reply.reason)) {
      // Transient (stale, overloaded, model loading/unavailable, inference error): retry with backoff.
      for (const m of group) {
        const s = this.states.get(m);
        if (s && s.identity === identity && s.phase === "inflight") {
          s.phase = "dirty";
          if (++s.attempts <= 5 || reply.reason === "stale") this.retry.add(m);
        }
      }
      if (reply.reason !== "stale") this.count(reply.reason);
      this.scheduleRetry(reply.reason === "stale" ? 0 : this.retryDelay);
      if (reply.reason !== "stale") this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    } else {
      // Cannot be analysed with the current settings: left visible, counted once per identity.
      this.count(reply.reason);
      for (const m of group) {
        const s = this.states.get(m);
        if (s && s.identity === identity && s.phase === "inflight") {
          s.phase = "skipped";
          if (s.matched) {
            s.matched = false;
            this.render(m, s);
          }
        }
      }
    }
    this.flush();
  }

  private async imagePayload(el: Element): Promise<VisionRequest["image"]> {
    const info = mediaInfo(el, this.protectedSelector);
    if (!info.ok) throw new Skipped("ineligible-url", "no longer eligible");
    try {
      return { kind: "pixels", rgb: bytesToBase64(await readPixels(el, info)) };
    } catch (err) {
      if (!(err instanceof PixelsUnavailable)) throw err;
      if (isLocalImageUrl(info.url) || !/^https?:/i.test(info.url)) throw new Skipped("decode", err.message);
      if (!this.settings!.imageDownloads) throw new Skipped("cross-origin", err.message);
      return { kind: "url", url: info.url };
    }
  }

  private count(reason: SkipReason): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
  }

  private scheduleRetry(delay: number): void {
    if (this.retryTimer !== null || this.retry.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      for (const el of this.retry) if (this.near.has(el) && el.isConnected) this.enqueue(el);
      this.retry.clear();
      this.flush();
    }, delay);
  }

  private finish(el: Element, st: MediaState, d: VisionDecision): void {
    if (st.phase !== "done") this.analyzed++;
    st.phase = "done";
    st.matched = d.matched;
    this.render(el, st);
  }

  /**
   * Apply an element's visual state. A matched image inside an element the
   * controller already hides (a feed item matched by text) is not blurred a
   * second time — one reveal must be enough; inside a revealed item it stays
   * visible.
   */
  render(el: Element, st = this.states.get(el)): void {
    if (!st || !this.active) return;
    if (!st.matched || st.revealedIdentity === st.identity || this.coveredByAncestor(el)) {
      if (visualState(el) && el.hasAttribute(MEDIA_ATTR)) clearMedia(el);
      return;
    }
    el.setAttribute(MEDIA_ATTR, "");
    applyBlur(el, this.deps.owner);
  }

  private coveredByAncestor(el: Element): boolean {
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (a.getAttribute(OWNER_ATTR) === this.deps.owner && a.hasAttribute(STATE_ATTR)) return true;
    }
    return false;
  }

  /** The user revealed `el` (an image or an item containing images). */
  revealed(el: Element): void {
    const targets = this.tracked.has(el) ? [el] : [...this.tracked].filter((m) => el.contains(m));
    for (const m of targets) {
      const st = this.states.get(m);
      if (st) st.revealedIdentity = st.identity;
      if (m === el) markRevealed(m, this.deps.owner);
      else if (m.hasAttribute(MEDIA_ATTR)) clearMedia(m);
    }
  }

  /** An ancestor item was hidden or shown by the controller: re-render images inside it. */
  refreshWithin(el: Element): void {
    for (const m of this.tracked) if (m !== el && el.contains(m)) this.render(m);
  }
}

class Skipped extends Error {
  readonly reason: SkipReason;

  constructor(reason: SkipReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

function clearMedia(el: Element): void {
  el.removeAttribute(MEDIA_ATTR);
  clearVisual(el);
}
