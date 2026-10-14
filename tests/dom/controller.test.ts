/**
 * DOM integration tests: the production FilterController in real Chromium,
 * with a scripted classifier (tests/dom/harness.ts) so every ordering and
 * race can be reproduced deterministically.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";

import { harnessPage, launch, settle, waitPending } from "../helpers/dom-page.ts";

let browser: Browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser.close();
});

const H = (page: Page) => ({
  apply: (patch: Record<string, unknown> = {}, url?: string) => page.evaluate(([p, u]) => (window as any).harness.apply(p, u), [patch, url] as const),
  respond: (i = 0, needle = "MATCH") => page.evaluate(([i, n]) => (window as any).harness.respond(i, n), [i, needle] as const),
  pendingTexts: () => page.evaluate(() => (window as any).harness.pendingTexts() as string[][]),
  pendingCount: () => page.evaluate(() => (window as any).harness.pendingCount() as number),
  log: () => page.evaluate(() => (window as any).harness.log()),
  state: (id: string) => page.evaluate((id) => document.getElementById(id)!.getAttribute("data-clearscroll"), id),
  stop: () => page.evaluate(() => (window as any).harness.controller.stop()),
});

const BASIC = `
  <main>
    <p id="a">Bitcoin MATCH prices rallied this week after approval.</p>
    <p id="b" style="color: rgb(1, 2, 3); filter: grayscale(1)" class="keep">The bakery opened a new branch in town.</p>
    <p id="c"><a id="c-link" href="#clicked">Ethereum <b>MATCH</b> upgrade</a> went live without issues.</p>
  </main>`;

test("blurs matched units only and leaves page styles, classes and children untouched", async () => {
  const page = await harnessPage(browser, BASIC);
  const h = H(page);
  const before = await page.evaluate(() => ({ b: document.getElementById("b")!.outerHTML, c: document.getElementById("c")!.innerHTML }));
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  assert.equal(await h.state("b"), null);
  assert.equal(await h.state("c"), "blurred");
  const b = await page.evaluate(() => document.getElementById("b")!.outerHTML);
  assert.equal(b, before.b, "unmatched element is byte-identical");
  assert.equal(await page.evaluate(() => document.getElementById("c")!.innerHTML), before.c, "children are never rewritten");
  const filter = await page.evaluate(() => getComputedStyle(document.getElementById("a")!).filter);
  assert.match(filter, /blur/);
  await page.close();
});

test("stop() is fully reversible: attributes added by us are removed, page attributes kept", async () => {
  const page = await harnessPage(browser, `<main><p id="x" style="filter: grayscale(1)" title="page title">Bitcoin MATCH is up again today.</p><p id="y" tabindex="-1">Another MATCH line that is long.</p></main>`);
  const h = H(page);
  const original = await page.evaluate(() => [document.getElementById("x")!.outerHTML, document.getElementById("y")!.outerHTML]);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  const during = await page.evaluate(() => {
    const x = document.getElementById("x")!;
    return { tab: x.getAttribute("tabindex"), title: x.getAttribute("title"), ytab: document.getElementById("y")!.getAttribute("tabindex") };
  });
  assert.equal(during.tab, "0", "made keyboard-focusable while blurred");
  assert.equal(during.title, "page title", "existing title is never overwritten");
  assert.equal(during.ytab, "-1", "existing tabindex is never overwritten");
  await h.stop();
  const restored = await page.evaluate(() => [document.getElementById("x")!.outerHTML, document.getElementById("y")!.outerHTML]);
  assert.deepEqual(restored, original);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("x")!).filter), "grayscale(1)");
  await page.close();
});

test("inline children of one paragraph are classified together as one unit", async () => {
  const page = await harnessPage(browser, `<main><p id="p">Bit<b>coin</b> <a href="#">news</a> <span>today, all day long</span></p></main>`);
  await H(page).apply();
  await waitPending(page, 1);
  assert.deepEqual(await H(page).pendingTexts(), [["Bitcoin news today, all day long"]]);
  await page.close();
});

test("containers with block children, protected areas and skipped tags are never sent", async () => {
  const page = await harnessPage(
    browser,
    `<main>
      <div id="container">Loose container text here <p id="inner">Inner paragraph text is long enough</p></div>
      <nav><p>Navigation paragraph text MATCH</p></nav>
      <button>Button label MATCH long</button>
      <div class="custom-protect"><p>Custom protected MATCH text</p></div>
      <pre>code block MATCH contents</pre>
      <textarea>user input MATCH text</textarea>
      <div contenteditable="true"><p>Editable MATCH content here</p></div>
    </main>`
  );
  await H(page).apply({ protectedSelectors: [".custom-protect", "a[[invalid"] });
  await waitPending(page, 1);
  assert.deepEqual(await H(page).pendingTexts(), [["Inner paragraph text is long enough"]]);
  await page.close();
});

test("out-of-order replies are applied to the right elements", async () => {
  const many = Array.from({ length: 30 }, (_, i) => `<p id="p${i}">Paragraph ${i} ${i % 2 ? "MATCH" : "plain"} with enough text</p>`).join("");
  const page = await harnessPage(browser, `<main class="compact">${many}</main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 2); // 24 + 6 → two batches in flight
  const batches = await h.pendingTexts();
  assert.equal(batches.length, 2);
  await h.respond(1); // second batch first
  await settle(page, 30);
  await h.respond(0);
  await settle(page);
  for (let i = 0; i < 30; i++) assert.equal(await h.state(`p${i}`), i % 2 ? "blurred" : null, `p${i}`);
  await page.close();
});

test("a reply computed for old settings is discarded after a settings change", async () => {
  const page = await harnessPage(browser, BASIC);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.apply({ topics: [{ id: "t2", text: "sports", enabled: true }] }); // generation bump
  await waitPending(page, 2);
  await h.respond(0); // stale reply (old topic) says MATCH → must not blur
  await settle(page);
  assert.equal(await h.state("a"), null);
  const log = await h.log();
  assert.deepEqual(log.map((r: any) => r.topics), [["crypto"], ["sports"]]);
  await h.respond(0, "NOTHING"); // current reply: nothing matches
  await settle(page);
  assert.equal(await h.state("a"), null);
  await page.close();
});

test("disabling filtering while a request is in flight never re-blurs afterwards", async () => {
  const page = await harnessPage(browser, BASIC);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.apply({ enabled: false });
  await h.respond(0);
  await settle(page);
  assert.equal(await page.evaluate(() => document.querySelectorAll("[data-clearscroll]").length), 0);
  assert.equal(await H(page).pendingCount(), 0, "no new requests while paused");
  await page.close();
});

test("excluded sites stop filtering and clear existing blur", async () => {
  const page = await harnessPage(browser, BASIC);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  await h.apply({ excludedSites: ["example.test"] }, "https://news.example.test/x");
  assert.equal(await h.state("a"), null);
  assert.equal(await page.evaluate(() => (window as any).harness.state().activity), "excluded");
  await page.close();
});

test("text that changes while its request is in flight is re-classified, not mislabelled", async () => {
  const page = await harnessPage(browser, `<main><p id="a">Bitcoin MATCH prices rallied this week.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => (document.getElementById("a")!.firstChild as Text).data = "A calm story about gardening and tomatoes.");
  await h.respond(0); // old text matched — must be ignored
  await settle(page);
  assert.equal(await h.state("a"), null);
  await waitPending(page, 1);
  assert.deepEqual(await h.pendingTexts(), [["A calm story about gardening and tomatoes."]]);
  await page.close();
});

test("characterData edits of existing text nodes trigger re-analysis and unblur", async () => {
  const page = await harnessPage(browser, `<main><p id="a">Bitcoin MATCH prices rallied this week.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  await page.evaluate(() => (document.getElementById("a")!.firstChild as Text).data = "Now it is about the weather instead.");
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), null);
  await page.close();
});

test("removed elements are ignored safely", async () => {
  const page = await harnessPage(browser, BASIC);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => document.getElementById("a")!.remove());
  await h.respond();
  await settle(page);
  assert.equal(await h.state("c"), "blurred");
  await page.close();
});

test("dynamically added content (feeds, SPA renders) is analysed", async () => {
  const page = await harnessPage(browser, `<main id="feed"><p>Initial plain post with text.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await page.evaluate(() => {
    const art = document.createElement("article");
    art.innerHTML = `<h2 id="new-h">New MATCH headline arrives</h2><p id="new-p">And a plain body paragraph.</p>`;
    document.getElementById("feed")!.append(art);
  });
  await waitPending(page, 1);
  assert.deepEqual(await h.pendingTexts(), [["New MATCH headline arrives", "And a plain body paragraph."]]);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("new-h"), "blurred");
  assert.equal(await h.state("new-p"), null);
  await page.close();
});

test("content far below the viewport is not classified until scrolled near", async () => {
  const page = await harnessPage(browser, `<main><p id="top">Top MATCH paragraph text here.</p><div style="height: 5000px"></div><p id="far">Far away MATCH paragraph text.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  assert.deepEqual(await h.pendingTexts(), [["Top MATCH paragraph text here."]]);
  await h.respond();
  await page.evaluate(() => document.getElementById("far")!.scrollIntoView());
  await waitPending(page, 1);
  assert.deepEqual(await h.pendingTexts(), [["Far away MATCH paragraph text."]]);
  await page.close();
});

test("at most two requests are in flight (backpressure)", async () => {
  const many = Array.from({ length: 120 }, (_, i) => `<p>Line ${i} MATCH with enough text in it</p>`).join("");
  const page = await harnessPage(browser, `<main class="compact">${many}</main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 2);
  await settle(page, 300);
  assert.equal(await h.pendingCount(), 2);
  await h.respond(0);
  await waitPending(page, 2);
  assert.equal(await h.pendingCount(), 2);
  await page.close();
});

test("click reveals without activating the link underneath; keyboard reveal works", async () => {
  const page = await harnessPage(browser, BASIC);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  await page.click("#c-link");
  assert.equal(await h.state("c"), "revealed");
  assert.notEqual(await page.evaluate(() => location.hash), "#clicked", "first click must not follow the link");
  await page.click("#c-link");
  assert.equal(await page.evaluate(() => location.hash), "#clicked", "revealed content behaves normally");

  await page.focus("#a");
  await page.keyboard.press("Enter");
  assert.equal(await h.state("a"), "revealed");
  await page.close();
});

test("revealed items stay revealed across a settings change, but re-blur when their text changes", async () => {
  const page = await harnessPage(browser, `<main><p id="a">Bitcoin MATCH prices rallied this week.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  await page.click("#a");
  assert.equal(await h.state("a"), "revealed");
  await h.apply({ mode: "balanced" });
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "revealed");
  await page.evaluate(() => (document.getElementById("a")!.firstChild as Text).data = "Different MATCH content about coins now.");
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  await page.close();
});

test("an invalidated extension context stops filtering and cleans up", async () => {
  const page = await harnessPage(browser, BASIC);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.fail(0, new Error("Extension context invalidated.")));
  await settle(page);
  assert.equal(await page.evaluate(() => (window as any).harness.invalidated()), 1);
  assert.equal(await page.evaluate(() => (window as any).harness.state().activity), "stopped");
  await page.close();
});

test("unreachable engine falls back to local keyword matching", async () => {
  const page = await harnessPage(browser, `<main><p id="a">The crypto market crashed overnight.</p><p id="b">Gardening tips for the spring.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.fail(0, new Error("Could not establish connection")));
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  assert.equal(await h.state("b"), null);
  assert.equal(await page.evaluate(() => (window as any).harness.state().engine.state), "lexical-fallback");
  await page.close();
});

test("failed requests are retried with backoff instead of being dropped", async () => {
  const page = await harnessPage(browser, `<main><p id="a">Bitcoin MATCH prices rallied this week.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.respondError(0, "Only a single offscreen document may be created."));
  assert.equal(await h.pendingCount(), 0);
  await waitPending(page, 1); // retried after ~500 ms
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  await page.close();
});

test("units from an engine-side stale reply are re-sent immediately", async () => {
  const page = await harnessPage(browser, `<main><p id="a">Bitcoin MATCH prices rallied this week.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.respondError(0, "stale", true));
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  await page.close();
});

// ── Regression tests for review findings ────────────────────────────────────

test("a unit detached while in flight is re-sent after re-attachment (same node)", async () => {
  const page = await harnessPage(browser, `<main id="m"><p id="a">Bitcoin MATCH prices rallied this week.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => {
    const el = document.getElementById("a")!;
    (window as any).keep = el;
    el.remove();
  });
  await h.respond();
  await settle(page);
  await page.evaluate(() => document.getElementById("m")!.append((window as any).keep));
  await waitPending(page, 1);
  assert.deepEqual(await h.pendingTexts(), [["Bitcoin MATCH prices rallied this week."]]);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  await page.close();
});

test("a unit detached while queued is re-sent after re-attachment (same node)", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `<p id="q${i}">Line ${i} MATCH with enough text in it</p>`).join("");
  const page = await harnessPage(browser, `<main id="m" class="compact">${many}</main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 2); // 8 + 24 in flight, 8 still queued
  await page.evaluate(() => {
    const el = document.getElementById("q39")!;
    (window as any).keep = el;
    el.remove();
  });
  await h.respond(0);
  await h.respond(0);
  await waitPending(page, 1); // remaining queued units (q39 skipped: detached)
  await h.respond(0);
  await settle(page);
  await page.evaluate(() => document.getElementById("m")!.append((window as any).keep));
  await waitPending(page, 1);
  assert.deepEqual(await h.pendingTexts(), [["Line 39 MATCH with enough text in it"]]);
  await page.close();
});

test("keyword verdicts after a transient messaging error are provisional and retried", async () => {
  const page = await harnessPage(browser, `<main><p id="a">The crypto market crashed overnight.</p><p id="b">Gardening tips for the spring season.</p></main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await page.evaluate(() => (window as any).harness.fail(0, new Error("The message port closed before a response was received.")));
  await settle(page);
  assert.equal(await h.state("a"), "blurred", "keyword fallback applies immediately");
  await waitPending(page, 1); // retried once the engine may be reachable again
  assert.deepEqual(await h.pendingTexts(), [["The crypto market crashed overnight.", "Gardening tips for the spring season."]]);
  await h.respond(0, "Gardening"); // semantic verdict replaces the provisional one
  await settle(page);
  assert.equal(await h.state("a"), null);
  assert.equal(await h.state("b"), "blurred");
  await page.close();
});

test("an orphaned controller cleaning up does not remove another instance's blur", async () => {
  const page = await harnessPage(browser, `<main><p id="a">Bitcoin MATCH prices rallied this week.</p><p id="b">Second MATCH paragraph about coins.</p></main>`);
  const h = H(page);
  await h.apply(); // old instance
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  await page.evaluate(() => {
    (window as any).harness.createSecond(); // updated extension's content script
    (window as any).harness.applySecond();
  });
  await page.waitForFunction(() => (window as any).harness.secondPendingCount() >= 1);
  await page.evaluate(() => (window as any).harness.respondSecond());
  await settle(page);
  await h.stop(); // old instance invalidated → tears down
  assert.equal(await h.state("a"), "blurred", "blur owned by the live instance survives");
  assert.equal(await h.state("b"), "blurred");
  await page.close();
});

test("keyboard reveal keeps focus on the item and removes it from the tab order", async () => {
  const page = await harnessPage(browser, `<main><p id="a">Bitcoin MATCH prices rallied this week.</p><p id="b" tabindex="0">A plain second paragraph of text.</p></main>`);
  const h = H(page);
  const original = await page.evaluate(() => document.getElementById("a")!.outerHTML);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  await page.focus("#a");
  await page.keyboard.press("Enter");
  assert.equal(await h.state("a"), "revealed");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "a", "focus stays on the revealed item");
  assert.equal(await page.evaluate(() => document.getElementById("a")!.getAttribute("tabindex")), "-1");
  // New content in the same element is blurred again and back in the tab order.
  await page.evaluate(() => ((document.getElementById("a")!.firstChild as Text).data = "Different MATCH content about coins now."));
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("a"), "blurred");
  assert.equal(await page.evaluate(() => document.getElementById("a")!.getAttribute("tabindex")), "0");
  await page.evaluate(() => ((document.getElementById("a")!.firstChild as Text).data = "Bitcoin MATCH prices rallied this week."));
  await waitPending(page, 1);
  await h.respond(0, "NOTHING");
  await settle(page);
  await h.stop();
  // Teardown while the item still has focus keeps focus in place; the markup
  // is fully restored as soon as focus moves on.
  await page.focus("#b");
  assert.equal(await page.evaluate(() => document.getElementById("a")!.outerHTML), original, "markup fully restored");
  await page.close();
});

test("clearing a focused item does not throw focus to <body>; the added tabindex goes once focus leaves", async () => {
  const page = await harnessPage(browser, `<main><p id="a">Bitcoin MATCH prices rallied this week.</p><p id="b" tabindex="0">Other focusable paragraph text.</p></main>`);
  const h = H(page);
  const original = await page.evaluate(() => document.getElementById("a")!.outerHTML);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  await page.focus("#a");
  // Its text changes to non-matching content → verdict clears the blur while it has focus.
  await page.evaluate(() => ((document.getElementById("a")!.firstChild as Text).data = "A calm story about gardening."));
  await waitPending(page, 1);
  await h.respond(0, "NOTHING");
  await settle(page);
  assert.equal(await h.state("a"), null);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "a", "focus kept");
  await page.focus("#b");
  await page.evaluate(() => ((document.getElementById("a")!.firstChild as Text).data = "Bitcoin MATCH prices rallied this week."));
  await waitPending(page, 1);
  await h.respond(0, "NOTHING");
  await settle(page);
  assert.equal(await page.evaluate(() => document.getElementById("a")!.outerHTML), original, "added attributes removed after blur");
  await page.close();
});

// ── Feed items: a match hides the whole card (thumbnail, title, metadata) ───

const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const card = (id: string, title: string, extra = "") => `
  <div class="card" id="${id}">
    <a href="#${id}-link" id="${id}-thumb-link"><img id="${id}-thumb" src="${GIF}" width="160" height="90" alt=""></a>
    <h3 id="${id}-title"><a href="#${id}-link">${title}</a></h3>
    <span id="${id}-meta">1.2M views · 2 days ago</span>
    ${extra}
  </div>`;
const FEED = `<main><div id="list">
  ${card("c1", "Everton MATCH Chelsea: highlights from the weekend", `<p id="c1-desc">Watch every goal and the reaction from the game.</p>`)}
  ${card("c2", "How to bake sourdough bread at home in a day", `<p id="c2-desc">A simple recipe for complete beginners.</p>`)}
  ${card("c3", "MATCH report: Arsenal beat Leeds in the late game")}
  ${card("c4", "Gardening tips for a small balcony this autumn")}
</div></main>`;

test("a matched feed item is hidden as a whole: thumbnail, title and metadata", async () => {
  const page = await harnessPage(browser, FEED);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("c1"), "blurred", "the card carries the blur");
  assert.equal(await h.state("c3"), "blurred");
  assert.equal(await h.state("c1-title"), null, "not blurred twice");
  assert.equal(await h.state("c2"), null, "unrelated cards stay visible");
  assert.equal(await h.state("c4"), null);
  assert.equal(await h.state("list"), null, "never the whole list");
  const thumbFilter = await page.evaluate(() => getComputedStyle(document.getElementById("c1")!).filter);
  assert.match(thumbFilter, /blur/, "the thumbnail is inside the blurred element");
  await page.close();
});

test("item hiding falls back to the text when there is no card or the card holds several stories", async () => {
  const page = await harnessPage(browser, `<main>
    <div id="textonly"><p id="t1">A MATCH headline without any picture next to it.</p><span>2h ago</span></div>
    <div id="bundle"><img src="${GIF}" width="200" height="120" alt="">
      <h3 id="b1">Main MATCH story of the day with a big photo</h3>
      <p id="b2">Related: council approves the new cycle lanes plan</p>
      <p id="b3">Related: museum reopens after two years of repairs</p>
      <p id="b4">Related: storm warning issued for the coast tonight</p>
    </div>
    <div id="tiny"><img src="${GIF}" width="24" height="24" alt=""><p id="a1">An avatar only MATCH comment that is long enough.</p></div>
  </main>`);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("t1"), "blurred");
  assert.equal(await h.state("textonly"), null, "no media: only the text is hidden");
  assert.equal(await h.state("b1"), "blurred");
  assert.equal(await h.state("bundle"), null, "several unrelated stories: never hidden together");
  assert.equal(await h.state("a1"), "blurred");
  assert.equal(await h.state("tiny"), null, "an avatar or icon does not make a card");
  await page.close();
});

test("a hidden item is revealed by one click without following its link, and stays revealed", async () => {
  const page = await harnessPage(browser, FEED);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  await page.click("#c1-thumb");
  assert.equal(await h.state("c1"), "revealed");
  assert.equal(await page.evaluate(() => location.hash), "", "the thumbnail link is not followed on the revealing click");
  // More text of the same card is classified later (e.g. a lazily rendered description).
  await page.evaluate(() => document.getElementById("c1")!.insertAdjacentHTML("beforeend", "<p id='c1-more'>Another MATCH sentence about the same match.</p>"));
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("c1"), "revealed", "a revealed card is not hidden again by more of its own text");
  await page.close();
});

test("an item is unhidden when its matching text changes, and stop() restores it exactly", async () => {
  const page = await harnessPage(browser, FEED);
  const h = H(page);
  const original = await page.evaluate(() => document.getElementById("c3")!.outerHTML);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("c3"), "blurred");
  await page.evaluate(() => {
    document.querySelector("#c3-title a")!.firstChild!.textContent = "Report: city library extends opening hours";
  });
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("c3"), null, "no member matches any more");
  assert.equal(await h.state("c1"), "blurred");
  await h.stop();
  assert.equal(await h.state("c1"), null);
  const attrs = await page.evaluate(() => [...document.querySelectorAll("*")].flatMap((e) => [...e.attributes].map((a) => a.name)).filter((n) => n.startsWith("data-clearscroll")));
  assert.deepEqual(attrs, [], "nothing of ours is left");
  await page.evaluate(() => { document.querySelector("#c3-title a")!.firstChild!.textContent = "MATCH report: Arsenal beat Leeds in the late game"; });
  assert.equal(await page.evaluate(() => document.getElementById("c3")!.outerHTML), original);
  await page.close();
});

test("a hidden item stays hidden across a settings change until its new verdict arrives", async () => {
  const page = await harnessPage(browser, FEED);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("c1"), "blurred");
  await h.apply({ mode: "aggressive" });
  await settle(page);
  assert.equal(await h.state("c1"), "blurred", "no flash of the old content while re-classifying");
  await waitPending(page, 1);
  await h.respond(0, "NOTHING-MATCHES");
  await settle(page);
  assert.equal(await h.state("c1"), null);
  await page.close();
});

test("a hidden item stays hidden when its metadata text updates in place", async () => {
  const page = await harnessPage(browser, FEED);
  const h = H(page);
  await h.apply();
  await waitPending(page, 1);
  await h.respond();
  await settle(page);
  assert.equal(await h.state("c1"), "blurred");
  // Feeds update relative times and counters in place ("2 days ago" → "3 days ago").
  await page.evaluate(() => { document.getElementById("c1-meta")!.firstChild!.textContent = "1.3M views · 3 days ago"; });
  await settle(page);
  assert.equal(await h.state("c1"), "blurred");
  await page.close();
});
