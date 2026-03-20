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
