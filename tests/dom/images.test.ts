/**
 * Image filtering in the production FilterController/ImageFilter, in real
 * Chromium. The image classifier is scripted (tests/dom/harness.ts) but
 * decides from the pixel frame the content script actually read: a red
 * picture "matches", any other colour does not. Real-model recognition is
 * covered by tests/e2e/vision.test.ts.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";

import fs from "node:fs";
import path from "node:path";

import { harnessPage, launch, settle, waitPending } from "../helpers/dom-page.ts";

const CAT_JPG = fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/images/cat.jpg"));

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

const H = (page: Page) => ({
  apply: (patch: Record<string, unknown> = {}) => page.evaluate((p) => (window as any).harness.apply({ images: true, ...p }), patch),
  state: (id: string) => page.evaluate((id) => document.getElementById(id)?.getAttribute("data-clearscroll") ?? null, id),
  media: (id: string) => page.evaluate((id) => document.getElementById(id)!.hasAttribute("data-clearscroll-media"), id),
  log: () => page.evaluate(() => (window as any).harness.imageLog() as { generation: number; kind: string; url?: string; red?: boolean }[]),
  mode: (m: "auto" | "manual") => page.evaluate((m) => (window as any).harness.setImageMode(m), m),
  pending: () => page.evaluate(() => (window as any).harness.imagePendingCount() as number),
  respond: (i = 0, matched?: boolean, generation?: number) => page.evaluate(([i, m, g]) => (window as any).harness.respondImage(i, m ?? undefined, g ?? undefined), [i, matched ?? null, generation ?? null] as const),
  fail: (i = 0, reason = "unavailable") => page.evaluate(([i, r]) => (window as any).harness.failImage(i, r), [i, reason] as const),
  imgState: () => page.evaluate(() => (window as any).harness.state().images),
});

/** Set `src` (or poster / background) of every [data-color] element to a solid-colour PNG. */
async function paint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const h = (window as any).harness;
    const loads: Promise<unknown>[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[data-color]")) {
      const [w, hgt] = (el.dataset.size ?? "320x240").split("x").map(Number);
      const url = h.solid(el.dataset.color, w, hgt);
      if (el instanceof HTMLImageElement) {
        el.src = url;
        loads.push(el.decode().catch(() => undefined));
      } else if (el instanceof HTMLSourceElement) el.srcset = url;
      else if (el instanceof HTMLVideoElement) el.poster = url;
      else el.style.backgroundImage = `url("${url}")`;
    }
    await Promise.all(loads);
  });
}

async function waitImages(page: Page, n: number): Promise<void> {
  await page.waitForFunction((n) => (window as any).harness.imageLog().length >= n, n, { timeout: 5000 });
}

const STYLE = `<style>main { display: flex; flex-wrap: wrap; gap: 4px; } img, video, .bg { width: 200px; height: 150px; display: block; } .bg { background-size: cover; } .icon { width: 24px; height: 24px; } p { margin: 0; }</style>`;

test("a textless picture is analysed from its pixels and blurred; others stay untouched", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><img id="red" data-color="red"><img id="blue" data-color="blue"><img id="green" data-color="#0a0"></main>`);
  const h = H(page);
  await paint(page);
  const before = await page.evaluate(() => [document.getElementById("blue")!.outerHTML, document.getElementById("red")!.getAttributeNames().sort().join()]);
  await h.apply();
  await waitImages(page, 3);
  await settle(page, 150);
  assert.equal(await h.state("red"), "blurred");
  assert.ok(await h.media("red"), "marked as media (stronger blur in content.css)");
  assert.equal(await h.state("blue"), null);
  assert.equal(await h.state("green"), null);
  assert.equal(await page.evaluate(() => document.getElementById("blue")!.outerHTML), before[0], "unmatched image is byte-identical");
  const log = await h.log();
  assert.ok(log.every((r) => r.kind === "pixels"), "pixels were read in the page; nothing was downloaded");
  assert.deepEqual((await h.imgState()).blurred, 1);
  // Stopping restores the page exactly.
  await page.evaluate(() => (window as any).harness.controller.stop());
  assert.equal(await page.evaluate(() => document.getElementById("red")!.getAttributeNames().sort().join()), before[1]);
  await page.close();
});

test("image filtering off: no image is read or sent, text filtering is unaffected", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><img id="red" data-color="red"><p id="t">Bitcoin MATCH prices rallied this week after approval.</p></main>`);
  const h = H(page);
  await paint(page);
  await h.apply({ images: false });
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.respond(0));
  await settle(page, 200);
  assert.equal(await h.state("t"), "blurred");
  assert.equal(await h.state("red"), null);
  assert.equal((await h.log()).length, 0);
  // Turning images on later analyses them; turning them off removes only image effects.
  await h.apply({ images: true });
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.respond(0));
  await waitImages(page, 1);
  await settle(page, 100);
  assert.equal(await h.state("red"), "blurred");
  await h.apply({ images: false });
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.respond(0));
  await settle(page, 100);
  assert.equal(await h.state("red"), null, "image blur removed");
  assert.equal(await h.state("t"), "blurred", "text blur kept");
  await page.close();
});

test("responsive <picture>: the selected source's pixels are analysed", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><picture><source data-color="red" type="image/png"><img id="pic" data-color="blue"></picture></main>`);
  const h = H(page);
  await paint(page);
  await page.waitForFunction(() => (document.getElementById("pic") as HTMLImageElement).currentSrc.length > 0 && (document.getElementById("pic") as HTMLImageElement).complete);
  await h.apply();
  await waitImages(page, 1);
  await settle(page, 100);
  assert.equal(await h.state("pic"), "blurred", "currentSrc (the red <source>) was used, not the blue fallback src");
  await page.close();
});

test("lazy and late images are analysed once loaded; a changed src is re-evaluated and stale verdicts are dropped", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><img id="late"><img id="swap" data-color="blue"></main>`);
  const h = H(page);
  await paint(page);
  await h.mode("manual");
  await h.apply();
  await page.waitForFunction(() => (window as any).harness.imagePendingCount() === 1);
  // #late has no src yet: not analysed. Give it one.
  await page.evaluate(() => {
    const el = document.getElementById("late") as HTMLImageElement;
    el.src = (window as any).harness.solid("red");
  });
  await page.waitForFunction(() => (window as any).harness.imagePendingCount() === 2);
  // While #swap's (blue) request is in flight, its source becomes red.
  await page.evaluate(() => {
    (document.getElementById("swap") as HTMLImageElement).src = (window as any).harness.solid("red", 300, 200);
  });
  await settle(page, 100);
  await h.respond(0, true); // a "match" for the OLD blue picture of #swap
  await settle(page, 50);
  assert.equal(await h.state("swap"), null, "verdict for the previous src is not applied");
  // Answer the rest from their pixels.
  await h.mode("auto");
  while ((await h.pending()) > 0) await h.respond(0);
  await page.waitForFunction(() => document.getElementById("swap")!.getAttribute("data-clearscroll") === "blurred", null, { timeout: 5000 });
  assert.equal(await h.state("late"), "blurred");
  // Back to blue: the blur goes away after re-analysis.
  await page.evaluate(() => {
    (document.getElementById("swap") as HTMLImageElement).src = (window as any).harness.solid("blue", 300, 200);
  });
  await page.waitForFunction(() => document.getElementById("swap")!.getAttribute("data-clearscroll") === null, null, { timeout: 5000 });
  await page.close();
});

test("a verdict from a superseded settings generation is never applied", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><img id="red" data-color="red"></main>`);
  const h = H(page);
  await paint(page);
  await h.mode("manual");
  await h.apply();
  await page.waitForFunction(() => (window as any).harness.imagePendingCount() === 1);
  await h.apply({ mode: "aggressive" }); // new generation
  await page.waitForFunction(() => (window as any).harness.imagePendingCount() === 2);
  await h.respond(0); // old generation's answer
  await settle(page, 50);
  assert.equal(await h.state("red"), null);
  await h.respond(0);
  await settle(page, 50);
  assert.equal(await h.state("red"), "blurred");
  await page.close();
});

/** Wait for observable scheduler progress, without triggering a controller flush. */
async function waitPipeline(page: Page, expected: { inflight: number; queued: number; analyzed?: number }): Promise<void> {
  await page.waitForFunction((e) => {
    const s = (window as any).harness.state().images;
    return s.pipeline.inflight === e.inflight && s.pipeline.queued === e.queued && (e.analyzed === undefined || s.analyzed === e.analyzed);
  }, expected, { timeout: 5000 });
}

async function assertImageIdle(page: Page, requests: number): Promise<void> {
  await waitPipeline(page, { inflight: 0, queued: 0 });
  assert.equal(await H(page).pending(), 0);
  assert.equal((await H(page).log()).length, requests, "no duplicate requests");
  assert.ok(await page.evaluate(() => (window as any).harness.imageInflightMax() <= 2), "physical concurrency stays at most two");
  assert.equal(await page.evaluate(() => (window as any).harness.controller.images.waiting.size), 0, "completed waiter groups are removed");
}

const GENERATION_IMAGES = `${STYLE}<main><img id="a" data-color="red"><img id="b" data-color="blue"><img id="c" data-color="green"></main>`;

for (const reverse of [false, true]) {
  test(`generation lifecycle: two old slots release three queued images (${reverse ? "reverse" : "forward"} completion order)`, async (t) => {
    const page = await harnessPage(browser, GENERATION_IMAGES);
    t.after(() => page.close());
    const h = H(page);
    await paint(page);
    await h.mode("manual");
    await h.apply();
    await waitImages(page, 2);
    const oldGeneration = (await h.log())[0]!.generation;
    await h.apply({ mode: "aggressive" });
    await waitPipeline(page, { inflight: 2, queued: 3, analyzed: 0 });
    // No scrolling, mutations or manual flushing after this point.
    await h.respond(reverse ? 1 : 0, true);
    await h.respond(0, true); // the other old request, before any new one
    await waitImages(page, 4);
    assert.equal(await h.state("a"), null, "old match did not blur a current image");
    assert.equal(await h.state("b"), null);
    assert.equal((await h.imgState()).vision, null, "old diagnostics are ignored");
    assert.ok((await h.log()).slice(2).every((r) => r.generation > oldGeneration));
    await h.respond(0);
    await waitImages(page, 5);
    await h.respond(0);
    await h.respond(0);
    await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 3 });
    assert.deepEqual(await Promise.all(["a", "b", "c"].map(h.state)), ["blurred", null, null]);
    await assertImageIdle(page, 5);
  });
}

for (const oldFirst of [true, false]) {
  test(`generation lifecycle: same identity and duplicate waiters (old reply ${oldFirst ? "first" : "last"})`, async (t) => {
    const page = await harnessPage(browser, `${STYLE}<main><img id="a" data-color="red"><img id="b" data-color="red"><img id="c" data-color="red"></main>`);
    t.after(() => page.close());
    const h = H(page);
    await paint(page);
    await h.mode("manual");
    await h.apply();
    await waitPipeline(page, { inflight: 1, queued: 0 });
    await waitImages(page, 1);
    await h.apply({ mode: "balanced" });
    await waitImages(page, 2); // same identity, different generation
    if (oldFirst) {
      await h.respond(0, false); // must not delete the new group
      await waitPipeline(page, { inflight: 1, queued: 0 });
      assert.equal((await h.log()).length, 2, "duplicates joined the current request, not a third request");
      await h.respond(0, true);
    } else {
      await h.respond(1, true);
      await waitPipeline(page, { inflight: 1, queued: 0, analyzed: 3 });
      const vision = (await h.imgState()).vision;
      await h.respond(0, false); // must not overwrite the current cache or diagnostics
      await waitPipeline(page, { inflight: 0, queued: 0 });
      assert.deepEqual((await h.imgState()).vision, vision);
    }
    await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 3 });
    assert.deepEqual(await Promise.all(["a", "b", "c"].map(h.state)), ["blurred", "blurred", "blurred"]);
    // A late duplicate must use the current verdict rather than the old non-match.
    await page.evaluate(async () => {
      const img = document.createElement("img");
      img.id = "d";
      img.src = (document.getElementById("a") as HTMLImageElement).src;
      document.querySelector("main")!.append(img);
      await img.decode();
    });
    await page.waitForFunction(() => document.getElementById("d")!.getAttribute("data-clearscroll") === "blurred", null, { timeout: 5000 });
    await assertImageIdle(page, 2);
  });
}

test("generation lifecycle: repeated settings changes discard intermediate verdicts and retries", async (t) => {
  const page = await harnessPage(browser, GENERATION_IMAGES);
  t.after(() => page.close());
  const h = H(page);
  await paint(page);
  await h.mode("manual");
  await h.apply();
  await waitImages(page, 2);
  await h.apply({ mode: "balanced" });
  await waitPipeline(page, { inflight: 2, queued: 3 });
  await h.respond(1, true);
  await waitImages(page, 3); // second generation starts while first is unresolved
  await h.apply({ mode: "aggressive" });
  await waitPipeline(page, { inflight: 2, queued: 3 });
  await h.apply({ mode: "precision" }); // fourth generation; third never got a slot
  await h.fail(1, "unavailable"); // obsolete second generation must not retry/count
  await waitImages(page, 4);
  await h.fail(0, "decode"); // obsolete first generation must not skip current elements
  await waitImages(page, 5);
  assert.deepEqual((await h.imgState()).skipped, {});
  assert.equal((await h.imgState()).vision, null);
  await h.respond(0, false);
  await waitImages(page, 6);
  await h.respond(0, false);
  await h.respond(0, false);
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 3 });
  assert.deepEqual(await Promise.all(["a", "b", "c"].map(h.state)), [null, null, null]);
  const generations = (await h.log()).map((r) => r.generation);
  assert.ok(generations[0]! < generations[2]! && generations[2]! < generations[3]!);
  assert.equal(new Set(generations.slice(3)).size, 1, "only newest work starts after the last settings change");
  assert.equal(await page.evaluate(() => (window as any).harness.controller.images.retry.size), 0);
  await assertImageIdle(page, 6);
});

test("generation lifecycle: stop and re-enable retains physical slots and advances new work", async (t) => {
  const page = await harnessPage(browser, GENERATION_IMAGES);
  t.after(() => page.close());
  const h = H(page);
  await paint(page);
  await h.mode("manual");
  await h.apply();
  await waitImages(page, 2);
  await page.evaluate(() => (window as any).harness.controller.stop());
  await waitPipeline(page, { inflight: 2, queued: 0 });
  await h.respond(1, true);
  await waitPipeline(page, { inflight: 1, queued: 0, analyzed: 0 });
  assert.equal(await h.state("b"), null, "stopped request cannot blur");
  await h.apply();
  await waitImages(page, 3);
  await waitPipeline(page, { inflight: 2, queued: 2 });
  await h.respond(0, true); // last request from before stop
  await waitImages(page, 4);
  assert.equal(await h.state("a"), null, "obsolete match cannot blur after restart");
  await h.respond(0, false);
  await waitImages(page, 5);
  await h.respond(0, false);
  await h.respond(0, false);
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 3 });
  assert.deepEqual(await Promise.all(["a", "b", "c"].map(h.state)), [null, null, null]);
  await assertImageIdle(page, 5);
});

test("generation lifecycle: the queue stays bounded across settings changes", async (t) => {
  // Overlap eligible images so all 205 are near the viewport, with distinct identities.
  const imgs = Array.from({ length: 205 }, (_, i) => `<img id="i${i}" data-color="blue" data-size="${320 + i}x240">`).join("");
  const page = await harnessPage(browser, `${STYLE}<style>img { position:absolute; top:0; left:0; }</style><main>${imgs}</main>`);
  t.after(() => page.close());
  const h = H(page);
  await paint(page);
  await h.mode("manual");
  await h.apply();
  await waitImages(page, 2);
  const initialQueue = (await h.imgState()).pipeline.queued;
  assert.ok(initialQueue >= 198 && initialQueue <= 200, `initial queue is bounded (${initialQueue})`);
  await h.apply({ mode: "balanced" });
  await waitPipeline(page, { inflight: 2, queued: 200 });
  await h.respond(1, true);
  await h.respond(0, true);
  await waitImages(page, 4);
  assert.ok((await h.imgState()).pipeline.queued <= 200);
  // Drain exactly the admitted current queue: overflow retains the existing dirty policy.
  for (let n = 0; n < 200; n++) {
    await page.waitForFunction(() => (window as any).harness.imagePendingCount() > 0, null, { timeout: 5000 });
    await h.respond(0, false);
    assert.ok((await h.imgState()).pipeline.queued <= 200);
  }
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 200 });
  await assertImageIdle(page, 202);
});

for (const outcome of ["decode", "unavailable", "stale", "mismatched", "exception"]) {
  test(`generation lifecycle: ${outcome} completion frees capacity and preserves retries`, async (t) => {
    const page = await harnessPage(browser, GENERATION_IMAGES);
    t.after(() => page.close());
    const h = H(page);
    await paint(page);
    await h.mode("manual");
    if (outcome === "exception") {
      // Keep the harness's manual response control, but simulate a transport rejection.
      await page.evaluate(() => {
        const deps = (window as any).harness.controller.images.deps;
        const classify = deps.classifyImage;
        let first = true;
        deps.classifyImage = async (req: unknown) => {
          const reject = first;
          first = false;
          const reply = await classify(req);
          if (reject) throw new Error("scripted transport failure");
          return reply;
        };
      });
    }
    await h.apply();
    await waitImages(page, 2);
    if (outcome === "mismatched") await h.respond(0, true, -1);
    else if (outcome === "exception") await h.respond(0, true);
    else await h.fail(0, outcome);
    await waitImages(page, 3); // queued third image uses the freed slot
    if (outcome === "mismatched") {
      assert.equal(await h.state("a"), null, "wrong-generation success is not applied");
      assert.equal((await h.imgState()).vision, null, "wrong-generation diagnostics are not applied");
    }
    await h.respond(0, false);
    await h.respond(0, false);
    if (outcome !== "decode") {
      await waitImages(page, 4); // transient / stale / exception retries once answered
      await h.respond(0, false);
    }
    await waitPipeline(page, { inflight: 0, queued: 0, analyzed: outcome === "decode" ? 2 : 3 });
    assert.deepEqual(await Promise.all(["a", "b", "c"].map(h.state)), [null, null, null]);
    const skipped = (await h.imgState()).skipped;
    assert.deepEqual(skipped, outcome === "stale" || outcome === "mismatched" ? {} : { [outcome === "exception" ? "unavailable" : outcome]: 1 });
    await assertImageIdle(page, outcome === "decode" ? 3 : 4);
  });
}

test("generation lifecycle: context invalidation stops scheduling while old physical slots drain", async (t) => {
  const page = await harnessPage(browser, GENERATION_IMAGES);
  t.after(() => page.close());
  const h = H(page);
  await paint(page);
  await h.mode("manual");
  await page.evaluate(() => {
    const deps = (window as any).harness.controller.images.deps;
    const classify = deps.classifyImage;
    let first = true;
    deps.classifyImage = async (req: unknown) => {
      const reject = first;
      first = false;
      const reply = await classify(req);
      if (reject) throw new Error("Extension context invalidated");
      return reply;
    };
  });
  await h.apply();
  await waitImages(page, 2);
  await h.respond(0, true);
  await waitPipeline(page, { inflight: 1, queued: 0, analyzed: 0 });
  assert.equal((await h.imgState()).enabled, false);
  await h.respond(0, true);
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 0 });
  assert.deepEqual(await Promise.all(["a", "b", "c"].map(h.state)), [null, null, null]);
  await assertImageIdle(page, 2);
});

test("icons, tiny or extreme-shaped images, SVG, hidden and protected images are never analysed", async () => {
  const svg = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="red"/></svg>');
  const page = await harnessPage(
    browser,
    `${STYLE}<nav><img id="nav" data-color="red"></nav>
     <header role="banner"><img id="banner" data-color="red"></header>
     <main>
       <img id="icon" class="icon" data-color="red">
       <img id="tinynatural" data-color="red" data-size="20x20">
       <img id="strip" data-color="red" style="width:600px;height:40px">
       <img id="svg" src='${svg}'>
       <img id="hidden" data-color="red" style="visibility:hidden">
       <button><img id="inbutton" data-color="red"></button>
       <div class="sidebar"><img id="custom" data-color="red"></div>
       <img id="ok" data-color="red">
     </main>`
  );
  const h = H(page);
  await paint(page);
  await h.apply({ protectedSelectors: [".sidebar"] });
  await waitImages(page, 1);
  await settle(page, 200);
  assert.equal((await h.log()).length, 1, "only #ok was analysed");
  assert.equal(await h.state("ok"), "blurred");
  for (const id of ["nav", "banner", "icon", "tinynatural", "strip", "svg", "hidden", "inbutton", "custom"]) assert.equal(await h.state(id), null, id);
  await page.close();
});

test("visible thumbnails inside aria-hidden links (as on YouTube) are analysed; aria-hidden text is not", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><a id="thumb" href="#v" aria-hidden="true" tabindex="-1"><img id="t-img" data-color="red"></a><p aria-hidden="true" id="t-txt">Bitcoin MATCH prices rallied this week after approval.</p></main>`);
  const h = H(page);
  await paint(page);
  await h.apply();
  await waitImages(page, 1);
  await settle(page, 200);
  assert.equal(await h.state("t-img"), "blurred");
  assert.equal(await page.evaluate(() => (window as any).harness.pendingCount()), 0, "aria-hidden text is still protected");
  await page.close();
});

test("an image inside a link: the first click reveals without navigating, the next one follows the link", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><a id="a" href="#followed"><img id="img" data-color="red"></a></main>`);
  const h = H(page);
  await paint(page);
  await h.apply();
  await page.waitForFunction(() => document.getElementById("img")!.getAttribute("data-clearscroll") === "blurred");
  await page.click("#img");
  assert.equal(await h.state("img"), "revealed");
  assert.equal(await page.evaluate(() => location.hash), "");
  await page.click("#img");
  assert.equal(await page.evaluate(() => location.hash), "#followed");
  // Revealed stays revealed for the same picture, also across a settings change.
  await h.apply({ mode: "balanced" });
  await settle(page, 150);
  assert.notEqual(await h.state("img"), "blurred");
  await page.close();
});

test("keyboard: a blurred image is focusable and Enter reveals it", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><img id="img" data-color="red"></main>`);
  const h = H(page);
  await paint(page);
  await h.apply();
  await page.waitForFunction(() => document.getElementById("img")!.getAttribute("data-clearscroll") === "blurred");
  assert.equal(await page.evaluate(() => document.getElementById("img")!.getAttribute("tabindex")), "0");
  await page.focus("#img");
  await page.keyboard.press("Enter");
  assert.equal(await h.state("img"), "revealed");
  await page.close();
});

test("the same picture shown twice is analysed once", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><img id="a"><img id="b"></main>`);
  const h = H(page);
  await page.evaluate(async () => {
    const url = (window as any).harness.solid("red");
    for (const id of ["a", "b"]) (document.getElementById(id) as HTMLImageElement).src = url;
    await Promise.all(["a", "b"].map((id) => (document.getElementById(id) as HTMLImageElement).decode()));
  });
  await h.apply();
  await page.waitForFunction(() => document.querySelectorAll('[data-clearscroll="blurred"]').length === 2);
  assert.equal((await h.log()).length, 1);
  await page.close();
});

test("many images: requests are bounded and on-screen images go first", async () => {
  const imgs = Array.from({ length: 120 }, (_, i) => `<img id="i${i}" data-color="${i === 110 ? "red" : "blue"}">`).join("");
  const page = await harnessPage(browser, `${STYLE}<main>${imgs}</main>`);
  const h = H(page);
  await paint(page);
  await page.evaluate(() => document.getElementById("i110")!.scrollIntoView());
  await h.mode("manual");
  await h.apply();
  await page.waitForFunction(() => (window as any).harness.imagePendingCount() >= 1);
  await settle(page, 200);
  assert.ok((await h.pending()) <= 2, "at most IMAGE_MAX_INFLIGHT requests outstanding");
  // Answer what is pending until the on-screen red image is analysed.
  for (let i = 0; i < 10 && (await h.state("i110")) !== "blurred"; i++) {
    while ((await h.pending()) > 0) await h.respond(0);
    await settle(page, 30);
  }
  assert.equal(await h.state("i110"), "blurred", "the visible image was analysed among the first");
  assert.ok((await h.log()).length < 20, `off-screen images were not all analysed (${(await h.log()).length} requests)`);
  assert.ok((await page.evaluate(() => (window as any).harness.imageInflightMax())) <= 2);
  await page.close();
});

test("broken images are not sent; cross-origin images are skipped unless downloads are allowed", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><img id="broken" src="data:image/png;base64,AAAA"><img id="remote" src="https://img.example/pic-MATCH.png"></main>`);
  // Serve the cross-origin image (no CORS headers: its pixels cannot be read).
  await page.route("https://img.example/**", (route) => route.fulfill({ status: 200, contentType: "image/jpeg", body: CAT_JPG }));
  await page.evaluate(() => {
    const el = document.getElementById("remote") as HTMLImageElement;
    el.src = el.src + "?reload";
    return el.decode().catch(() => undefined);
  });
  const h = H(page);
  await h.apply();
  await settle(page, 300);
  assert.equal((await h.log()).length, 0, "neither the broken nor the unreadable image was sent");
  assert.equal(await h.state("remote"), null);
  assert.equal((await h.imgState()).skipped["cross-origin"], 1);
  // With downloads allowed the URL is sent instead (the offscreen document fetches it).
  await h.apply({ imageDownloads: true });
  await waitImages(page, 1);
  await settle(page, 100);
  const log = await h.log();
  assert.deepEqual(log.map((r) => r.kind), ["url"]);
  assert.match(log[0]!.url!, /^https:\/\/img\.example\/pic-MATCH\.png/);
  assert.equal(await h.state("remote"), "blurred");
  await page.close();
});

test("cards: image match hides the picture only; text match hides the card; one reveal shows everything", async () => {
  const page = await harnessPage(
    browser,
    `${STYLE}<main>
      <article id="c1"><img id="c1-img" data-color="red"><p id="c1-txt">Weekend weather: light rain in the morning, clearing later on.</p></article>
      <article id="c2"><img id="c2-img" data-color="blue"><p id="c2-txt">Bitcoin MATCH prices rallied this week after the approval.</p></article>
      <article id="c3"><img id="c3-img" data-color="#ee0000"><p id="c3-txt">Ethereum MATCH upgrade went live without any issues today.</p></article>
    </main>`
  );
  const h = H(page);
  await paint(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.respond(0));
  await waitImages(page, 3);
  await settle(page, 200);
  // c1: image only.
  assert.equal(await h.state("c1-img"), "blurred");
  assert.equal(await h.state("c1"), null);
  assert.equal(await h.state("c1-txt"), null, "unrelated text is not hidden");
  // c2: text match hides the whole card (its feed item), image verdict irrelevant.
  assert.equal(await h.state("c2"), "blurred");
  // c3: both match — the card is hidden once; the image is not blurred a second time inside it.
  assert.equal(await h.state("c3"), "blurred");
  assert.equal(await h.state("c3-img"), null, "no nested blur");
  await page.click("#c3", { position: { x: 30, y: 30 } });
  assert.equal(await h.state("c3"), "revealed");
  assert.notEqual(await h.state("c3-img"), "blurred", "one click reveals the picture too");
  await page.close();
});

test("video posters and CSS background pictures (data: URLs) are analysed", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><video id="v" data-color="red"></video><div id="bg" class="bg" role="img" data-color="red"></div><div id="deco" class="bg" data-color="red" style="position:fixed;inset:0"></div><div id="withtext" class="bg" data-color="red">A caption that is real text</div></main>`);
  const h = H(page);
  await paint(page);
  // #deco: inline style but fixed and full-viewport (decoration); #withtext holds text.
  await page.evaluate(() => {
    for (const id of ["deco", "withtext"]) document.getElementById(id)!.setAttribute("style", document.getElementById(id)!.getAttribute("style")! + ";background-size:cover");
  });
  await h.apply();
  await waitImages(page, 2);
  await settle(page, 200);
  assert.equal(await h.state("v"), "blurred");
  assert.equal(await h.state("bg"), "blurred");
  assert.equal(await h.state("deco"), null);
  assert.equal(await h.state("withtext"), null);
  assert.equal((await h.log()).length, 2);
  await page.close();
});

test("transient failures are retried; permanent ones are not", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><img id="a" data-color="red"><img id="b" data-color="#e00000"></main>`);
  const h = H(page);
  await paint(page);
  await h.mode("manual");
  await h.apply();
  await page.waitForFunction(() => (window as any).harness.imagePendingCount() === 2);
  const first = await h.log();
  const aFirst = first[0]!;
  await h.fail(0, "unavailable"); // e.g. model still loading → retry with backoff
  await h.fail(0, "decode"); // cannot be decoded → left visible, no retry
  await page.waitForFunction(() => (window as any).harness.imagePendingCount() === 1, null, { timeout: 5000 });
  await h.respond(0);
  await settle(page, 1500);
  assert.equal((await h.log()).length, 3, "only the transient failure was retried");
  assert.equal(aFirst.kind, "pixels");
  const blurred = await page.evaluate(() => document.querySelectorAll('[data-clearscroll="blurred"]').length);
  assert.equal(blurred, 1);
  const st = await h.imgState();
  assert.equal(st.skipped.decode, 1);
  await page.close();
});

test("dynamically inserted images (infinite scroll) are discovered and analysed", async () => {
  const page = await harnessPage(browser, `${STYLE}<main id="feed"></main>`);
  const h = H(page);
  await h.apply();
  await page.evaluate(async () => {
    for (const c of ["blue", "red", "blue"]) {
      const img = document.createElement("img");
      img.src = (window as any).harness.solid(c);
      img.dataset.c = c;
      document.getElementById("feed")!.append(img);
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-clearscroll="blurred"]').length === 1, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.querySelector('[data-clearscroll="blurred"]')!.getAttribute("data-c")), "red");
  await page.close();
});

test("pictures that fade in (opacity 0 when loaded, as on YouTube) are analysed once visible", async () => {
  const page = await harnessPage(browser, `${STYLE}<style>.fade { opacity: 0; transition: opacity 0.2s; } .fade.in { opacity: 1; }</style><main id="m"></main>`);
  const h = H(page);
  await h.apply();
  await page.evaluate(async () => {
    const img = document.createElement("img");
    img.id = "f";
    img.className = "fade";
    img.src = (window as any).harness.solid("red");
    document.getElementById("m")!.append(img);
    await img.decode();
    await new Promise((r) => setTimeout(r, 100)); // loaded while still transparent
    img.classList.add("in");
  });
  await page.waitForFunction(() => document.getElementById("f")!.getAttribute("data-clearscroll") === "blurred", null, { timeout: 5000 });
  await page.close();
});

test("pictures that are hidden or not laid out when loaded (lazy layouts) are analysed once shown", async () => {
  const page = await harnessPage(browser, `${STYLE}<main><div id="wrap" style="display:none"><img id="late-shown" data-color="red"></div></main>`);
  const h = H(page);
  await paint(page);
  await h.apply();
  await settle(page, 300);
  assert.equal((await h.log()).length, 0, "not analysed while hidden");
  // Shown by a style change on an ancestor: no load, transition or intersection-change event for the picture itself.
  await page.evaluate(() => (document.getElementById("wrap")!.style.display = "block"));
  await page.waitForFunction(() => document.getElementById("late-shown")!.getAttribute("data-clearscroll") === "blurred", null, { timeout: 5000 });
  await page.close();
});

// Detached-media lifecycle regressions use overlapping images so every batch
// is eligible in the real viewport, and distinct pixel identities across rounds.
const LIFECYCLE_PAGE = `${STYLE}<style>img, video, .bg { position:absolute; top:10px; left:10px; }</style><main id="feed"></main>`;

async function insertBatch(page: Page, round: number, count = 20): Promise<void> {
  await page.evaluate(async ({ round, count }) => {
    const feed = document.getElementById("feed")!;
    const loads: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      const img = document.createElement("img");
      img.id = `r${round}i${i}`;
      img.src = (window as any).harness.solid(`rgb(${round % 256},${i},100)`, 320 + round, 240);
      feed.append(img);
      loads.push(img.decode());
    }
    await Promise.all(loads);
  }, { round, count });
}

/** Deliver the current mutation batch and any cleanup-induced mutations. */
async function mutationBatch(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve))));
}

test("detached lifecycle: ten rounds of 20 analysed images return tracking to zero", async (t) => {
  const page = await harnessPage(browser, LIFECYCLE_PAGE);
  t.after(() => page.close());
  await H(page).apply();
  const counts: number[] = [];
  for (let round = 1; round <= 10; round++) {
    await insertBatch(page, round);
    await waitPipeline(page, { inflight: 0, queued: 0, analyzed: round * 20 });
    await page.evaluate(() => document.getElementById("feed")!.replaceChildren());
    await mutationBatch(page);
    counts.push((await H(page).imgState()).pipeline.tracked);
  }
  t.diagnostic(`tracked after removal: ${counts.join(" → ")}`);
  assert.deepEqual(counts, Array(10).fill(0), "tracking must follow connected media, not historical insertions");
  assert.equal(await page.locator("img").count(), 0);
  await assertImageIdle(page, 200);
});

/** Observe actual browser registrations without replacing IntersectionObserver. */
async function probeLifecycle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targets = new Set<Element>();
    const listeners = new Set<string>();
    const probe = { targets, listeners, duplicateListeners: 0, duplicateObserves: 0, observes: 0, unobserves: 0, disconnects: 0 };
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    const imageListener = (type: string, listener: unknown) => {
      const f = (window as any).harness.controller.images;
      return type === "load" && listener === f.onLoad || ["transitionend", "animationend"].includes(type) && listener === f.onTransitionEnd;
    };
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (imageListener(type, listener)) {
        if (listeners.has(type)) probe.duplicateListeners++;
        listeners.add(type);
      }
      add(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (imageListener(type, listener)) listeners.delete(type);
      remove(type, listener, options);
    }) as typeof document.removeEventListener;
    (window as any).lifecycleProbe = probe;
    const proto = IntersectionObserver.prototype;
    const observe = proto.observe;
    const unobserve = proto.unobserve;
    const disconnect = proto.disconnect;
    const ours = (io: IntersectionObserver) => io === (window as any).harness.controller.images.observer;
    proto.observe = function (el) {
      if (ours(this)) {
        if (targets.has(el)) probe.duplicateObserves++;
        targets.add(el);
        probe.observes++;
      }
      return observe.call(this, el);
    };
    proto.unobserve = function (el) {
      if (ours(this)) {
        targets.delete(el);
        probe.unobserves++;
      }
      return unobserve.call(this, el);
    };
    proto.disconnect = function () {
      if (ours(this)) {
        targets.clear();
        probe.disconnects++;
      }
      return disconnect.call(this);
    };
  });
}

async function lifecycleCounts(page: Page) {
  return page.evaluate(() => {
    const h = (window as any).harness;
    const f = h.controller.images;
    const groups = [...f.waiting.values()] as Map<Element, any>[];
    const strong = [f.tracked, f.queue, f.retry, f.pendingImages, ...groups] as (Set<Element> | Map<Element, any>)[];
    const retained = (window as any).retained ?? [];
    return {
      tracked: f.tracked.size as number,
      queued: f.queue.size as number,
      retry: f.retry.size as number,
      pending: f.pendingImages.size as number,
      groups: groups.length,
      waiters: groups.reduce((n, g) => n + g.size, 0),
      disconnected: strong.reduce((n, set) => n + [...set.keys()].filter((el) => !el.isConnected || el.ownerDocument !== document).length, 0),
      inconsistent: groups.reduce((n, g) => n + [...g].filter(([el, st]) => f.states.get(el) !== st || st.phase !== "inflight" || st.generation !== h.controller.currentGeneration).length, 0),
      staleWeakEntries: retained.filter((el: Element) => !el.isConnected && (f.states.has(el) || f.near.has(el) || f.observed.has(el))).length as number,
      observed: (window as any).lifecycleProbe?.targets.size as number | undefined,
      duplicateObserves: (window as any).lifecycleProbe?.duplicateObserves as number | undefined,
      duplicateListeners: (window as any).lifecycleProbe?.duplicateListeners as number | undefined,
      listeners: (window as any).lifecycleProbe?.listeners.size as number | undefined,
      active: f.active as boolean,
      waitingTimer: f.waitingTimer !== null,
      retryTimer: f.retryTimer !== null,
      inflight: f.inflight as number,
      maxPhysical: h.imageInflightMax() as number,
    };
  });
}

async function assertLifecycleClean(page: Page, tracked = 0): Promise<void> {
  await mutationBatch(page);
  const c = await lifecycleCounts(page);
  assert.equal(c.tracked, tracked);
  assert.equal(c.disconnected, 0, "no disconnected strong collection entries");
  assert.equal(c.inconsistent, 0, "waiters own the exact current state and generation");
  assert.equal(c.staleWeakEntries, 0, "detached states and observer flags are deleted");
  assert.equal(c.observed, tracked, "browser observation follows tracking");
  assert.equal(c.duplicateObserves, 0);
  assert.equal(c.duplicateListeners, 0);
  assert.equal(c.listeners, c.active ? 3 : 0, "one set of image event listeners while active");
  assert.ok(c.queued <= 200);
  assert.ok(c.maxPhysical <= 2);
  if (tracked === 0) {
    assert.equal(c.queued + c.retry + c.pending + c.waiters, 0);
    assert.equal(c.waitingTimer, false);
    assert.equal(c.retryTimer, false);
  }
}

// Tests intentionally retain removed nodes to verify weak-state deletion and
// detached markup restoration independently of garbage collection timing.
test("detached lifecycle: one large removed subtree releases done, queued, inflight, retry and pending media", async (t) => {
  const page = await harnessPage(browser, LIFECYCLE_PAGE);
  t.after(() => page.close());
  const h = H(page);
  await probeLifecycle(page);
  await insertBatch(page, 1, 240);
  await page.evaluate(() => {
    // Include poster/background discovery, then remove their discovery
    // attributes before delivery: cleanup must use membership, not selectors.
    const feed = document.getElementById("feed")!;
    const url = (window as any).harness.solid("red");
    feed.insertAdjacentHTML("beforeend", '<video id="poster"></video><div class="bg" role="img" id="background"></div>');
    (document.getElementById("poster") as HTMLVideoElement).poster = url;
    (document.getElementById("background") as HTMLElement).style.backgroundImage = `url("${url}")`;
    (document.getElementById("r1i239") as HTMLElement).style.opacity = "0";
  });
  await h.mode("manual");
  await h.apply();
  await waitImages(page, 2);
  // A callback can admit 200 then immediately start two physical requests.
  await page.waitForFunction(() => {
    const p = (window as any).harness.state().images.pipeline;
    return p.inflight === 2 && p.queued >= 198 && p.queued <= 200;
  }, null, { timeout: 5000 });
  assert.equal((await lifecycleCounts(page)).tracked, 242);
  await h.respond(0, true);
  await waitImages(page, 3);
  await h.fail(0, "unavailable");
  await waitImages(page, 4);
  assert.equal((await lifecycleCounts(page)).retry, 1);
  assert.ok((await lifecycleCounts(page)).queued <= 200);
  assert.equal((await lifecycleCounts(page)).pending, 1);
  await page.evaluate(() => {
    const bg = document.getElementById("background")!;
    bg.removeAttribute("role");
    bg.removeAttribute("style");
    document.getElementById("poster")!.removeAttribute("poster");
    (window as any).retained = [...document.querySelectorAll("#feed img, #feed video, #feed .bg")];
    document.getElementById("feed")!.remove();
  });
  await assertLifecycleClean(page);
  assert.equal((await lifecycleCounts(page)).inflight, 2, "removal does not release physical slots");
  assert.equal(await page.evaluate(() => (window as any).retained.some((el: Element) => el.hasAttribute("data-clearscroll-media"))), false);
  await h.respond(0, true);
  await h.respond(0, true);
  await assertImageIdle(page, 4);
  await assertLifecycleClean(page);
});

test("detached lifecycle: removed queued images are never sent and connected work progresses", async (t) => {
  const page = await harnessPage(browser, LIFECYCLE_PAGE);
  t.after(() => page.close());
  const h = H(page);
  await probeLifecycle(page);
  await insertBatch(page, 2, 8);
  await h.mode("manual");
  await h.apply();
  await waitImages(page, 2);
  await waitPipeline(page, { inflight: 2, queued: 6 });
  await page.evaluate(() => {
    const f = (window as any).harness.controller.images;
    const removed = [...f.queue].slice(0, 3) as Element[];
    (window as any).retained = removed;
    for (const el of removed) el.remove();
  });
  await mutationBatch(page);
  await waitPipeline(page, { inflight: 2, queued: 3 });
  await assertLifecycleClean(page, 5);
  for (let n = 0; n < 5; n++) {
    await page.waitForFunction(() => (window as any).harness.imagePendingCount() > 0, null, { timeout: 5000 });
    await h.respond(0, false);
  }
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 5 });
  assert.equal(await page.evaluate(() => (window as any).retained.some((el: Element) => (window as any).harness.controller.images.states.has(el))), false);
  await assertImageIdle(page, 5);
  await assertLifecycleClean(page, 5);
});

for (const outcome of ["match", "unavailable", "decode"]) {
  test(`detached lifecycle: inflight removal followed by ${outcome} releases capacity once`, async (t) => {
    const page = await harnessPage(browser, LIFECYCLE_PAGE);
    t.after(() => page.close());
    const h = H(page);
    await probeLifecycle(page);
    await insertBatch(page, 3, 4);
    await h.mode("manual");
    await h.apply();
    await waitImages(page, 2);
    await page.evaluate(() => {
      const f = (window as any).harness.controller.images;
      const firstGroup = [...f.waiting.values()][0] as Map<Element, unknown>;
      (window as any).removedGroup = firstGroup;
      (window as any).retained = [...firstGroup.keys()];
      for (const el of firstGroup.keys()) el.remove();
    });
    await mutationBatch(page);
    await assertLifecycleClean(page, 3);
    assert.equal(await page.evaluate(() => (window as any).removedGroup.size), 0);
    assert.equal((await lifecycleCounts(page)).inflight, 2);
    if (outcome === "match") await h.respond(0, true);
    else await h.fail(0, outcome);
    await waitImages(page, 3);
    assert.equal((await h.imgState()).analyzed, 0);
    assert.equal(await page.evaluate(() => (window as any).retained[0].hasAttribute("data-clearscroll")), false);
    await h.respond(0, false);
    await waitImages(page, 4);
    await h.respond(0, false);
    await h.respond(0, false);
    await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 3 });
    await assertImageIdle(page, 4);
    await assertLifecycleClean(page, 3);
  });
}

test("detached lifecycle: shared request keeps connected waiters when its initiating image is removed", async (t) => {
  const page = await harnessPage(browser, `${STYLE}<main id="feed"><img id="a" data-color="red"><img id="b" data-color="red"><img id="c" data-color="red"></main>`);
  t.after(() => page.close());
  const h = H(page);
  await probeLifecycle(page);
  await paint(page);
  await h.mode("manual");
  await h.apply();
  await waitImages(page, 1);
  await waitPipeline(page, { inflight: 1, queued: 0 });
  assert.equal((await lifecycleCounts(page)).waiters, 3);
  await page.evaluate(() => {
    const el = document.getElementById("a")!;
    (window as any).retained = [el];
    el.remove();
  });
  await assertLifecycleClean(page, 2);
  assert.equal((await lifecycleCounts(page)).waiters, 2);
  await h.respond(0, true);
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 2 });
  assert.deepEqual(await Promise.all(["b", "c"].map(h.state)), ["blurred", "blurred"]);
  await assertImageIdle(page, 1);
  await assertLifecycleClean(page, 2);
});

test("detached lifecycle: DOM moves, parent replacement and synchronous subtree reinsertion preserve state", async (t) => {
  const page = await harnessPage(browser, `${STYLE}<main id="feed"><div id="left"><img id="a" data-color="red"></div><div id="right"></div></main>`);
  t.after(() => page.close());
  const h = H(page);
  await probeLifecycle(page);
  await paint(page);
  await h.apply();
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 1 });
  await page.evaluate(() => {
    const a = document.getElementById("a")!;
    (window as any).savedState = (window as any).harness.controller.images.states.get(a);
    const right = document.getElementById("right")!;
    right.append(a);
    const replacement = document.createElement("div");
    replacement.append(a);
    right.replaceWith(replacement);
    replacement.remove();
    document.getElementById("feed")!.append(replacement);
  });
  await assertLifecycleClean(page, 1);
  assert.equal(await page.evaluate(() => (window as any).savedState === (window as any).harness.controller.images.states.get(document.getElementById("a"))), true);
  assert.equal((await lifecycleCounts(page)).observed, 1);
  assert.equal(await h.state("a"), "blurred");
  await assertImageIdle(page, 1);
});

for (const beforeReply of [true, false]) {
  test(`detached lifecycle: reattachment ${beforeReply ? "before" : "after"} the old reply safely reuses its request or verdict`, async (t) => {
    const page = await harnessPage(browser, `${STYLE}<main id="feed"><img id="a" data-color="red"></main>`);
    t.after(() => page.close());
    const h = H(page);
    await probeLifecycle(page);
    await paint(page);
    await h.mode("manual");
    await h.apply();
    await waitImages(page, 1);
    await page.evaluate(() => {
      const a = document.getElementById("a")!;
      (window as any).retained = [a];
      a.remove();
    });
    await assertLifecycleClean(page);
    if (!beforeReply) {
      await h.respond(0, true);
      await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 0 });
    }
    await page.evaluate(() => document.getElementById("feed")!.append((window as any).retained[0]));
    if (beforeReply) {
      await page.waitForFunction(() => [...(window as any).harness.controller.images.waiting.values()].some((g: any) => g.size === 1), null, { timeout: 5000 });
      await h.respond(0, true);
    }
    await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 1 });
    assert.equal(await h.state("a"), "blurred");
    await assertImageIdle(page, 1);
    await assertLifecycleClean(page, 1);
    // A recycled element with a different identity must not reuse the red verdict.
    await page.evaluate(() => (window as any).retained[0].remove());
    await assertLifecycleClean(page);
    await page.evaluate(async () => {
      const a = (window as any).retained[0] as HTMLImageElement;
      a.src = (window as any).harness.solid("blue");
      await a.decode();
      document.getElementById("feed")!.append(a);
    });
    await waitImages(page, 2);
    await h.respond(0, false);
    await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 2 });
    assert.equal(await h.state("a"), null);
    await assertImageIdle(page, 2);
  });
}

test("detached lifecycle: removal, stop, restart and new generation preserve physical slots", async (t) => {
  const page = await harnessPage(browser, LIFECYCLE_PAGE);
  t.after(() => page.close());
  const h = H(page);
  await probeLifecycle(page);
  await insertBatch(page, 4, 3);
  await h.mode("manual");
  await h.apply();
  await waitImages(page, 2);
  await page.evaluate(() => {
    const f = (window as any).harness.controller.images;
    (window as any).oldGroups = [...f.waiting.values()];
    const a = document.getElementById("r4i0")!;
    (window as any).retained = [a];
    a.remove();
  });
  await mutationBatch(page);
  await page.evaluate(() => (window as any).harness.controller.stop());
  await assertLifecycleClean(page);
  assert.equal((await lifecycleCounts(page)).inflight, 2);
  assert.equal(await page.evaluate(() => (window as any).oldGroups.every((g: Map<Element, unknown>) => g.size === 0)), true);
  await h.apply({ mode: "aggressive" });
  await insertBatch(page, 5, 1);
  await waitPipeline(page, { inflight: 2, queued: 3 });
  await h.respond(0, true);
  await waitImages(page, 3);
  await h.respond(0, true);
  await waitImages(page, 4);
  assert.equal((await h.imgState()).analyzed, 0, "old replies cannot resurrect tracking or effects");
  await h.respond(0, false);
  await waitImages(page, 5);
  await h.respond(0, false);
  await h.respond(0, false);
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 3 });
  await assertLifecycleClean(page, 3);
  await assertImageIdle(page, 5);
  await page.evaluate(() => (window as any).harness.controller.stop());
  await assertLifecycleClean(page);
});

test("detached lifecycle: cleanup preserves another instance's markers and ignores stale intersection entries", async (t) => {
  const page = await harnessPage(browser, `${STYLE}<main id="feed"><img id="a" data-color="red"></main>`);
  t.after(() => page.close());
  const h = H(page);
  await probeLifecycle(page);
  await paint(page);
  await h.apply();
  await waitPipeline(page, { inflight: 0, queued: 0, analyzed: 1 });
  const original = await page.evaluate(() => {
    const a = document.getElementById("a")!;
    a.setAttribute("data-clearscroll-owner", "another-instance");
    const original = a.outerHTML;
    (window as any).retained = [a];
    a.remove();
    return original;
  });
  await assertLifecycleClean(page);
  await page.evaluate(() => {
    const f = (window as any).harness.controller.images;
    f.onIntersect([{ target: (window as any).retained[0], isIntersecting: true }]);
  });
  await assertLifecycleClean(page);
  await page.evaluate(() => (window as any).harness.controller.stop());
  assert.equal(await page.evaluate(() => (window as any).retained[0].outerHTML), original);
  await assertLifecycleClean(page);
});

test("detached lifecycle: 100 infinite-scroll batches keep retention proportional to connected media", async (t) => {
  const page = await harnessPage(browser, LIFECYCLE_PAGE);
  t.after(() => page.close());
  const h = H(page);
  await probeLifecycle(page);
  await h.apply();
  const samples: { cycle: number; connected: number; tracked: number; queued: number; inflight: number; observed: number | undefined; disconnected: number }[] = [];
  for (let cycle = 1; cycle <= 100; cycle++) {
    await insertBatch(page, cycle, 5);
    await waitPipeline(page, { inflight: 0, queued: 0, analyzed: cycle * 5 });
    await assertLifecycleClean(page, 5);
    const c = await lifecycleCounts(page);
    samples.push({ cycle, connected: await page.locator("img").count(), tracked: c.tracked, queued: c.queued, inflight: c.inflight, observed: c.observed, disconnected: c.disconnected });
    await page.evaluate(() => {
      (window as any).retained = [...document.querySelectorAll("#feed img")];
      document.getElementById("feed")!.replaceChildren();
    });
    await assertLifecycleClean(page);
    const removed = await lifecycleCounts(page);
    samples.push({ cycle, connected: 0, tracked: removed.tracked, queued: removed.queued, inflight: removed.inflight, observed: removed.observed, disconnected: removed.disconnected });
  }
  t.diagnostic(`cycle counters: ${JSON.stringify(samples)}`);
  assert.equal(Math.max(...samples.map((s) => s.tracked)), 5);
  assert.ok(samples.every((s) => s.tracked === s.connected && s.observed === s.connected && s.disconnected === 0));
  await assertImageIdle(page, 500);
  t.diagnostic(`final lifecycle counters: ${JSON.stringify(await lifecycleCounts(page))}`);
});
