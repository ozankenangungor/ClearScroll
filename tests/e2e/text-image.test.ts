/**
 * Text and image filtering together, end to end: the built extension with
 * both real models (MiniLM text engine, SigLIP image model) on one page of
 * cards (tests/fixtures/pages/mixed.html), topic "cats".
 *
 *   text − picture −  → untouched
 *   text + picture −  → the card is hidden by its text (picture not blurred separately)
 *   text − picture +  → only the picture is hidden
 *   text + picture +  → one hidden card, no nested blur, one reveal shows both
 *   text changes      → the stale verdict is dropped
 *   dog texts         → visible (sibling veto: closer to "dogs" than to "cats")
 *
 * Run `npm run build` first.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { attr, launchExtension, setSettings, waitAttr, waitRegistered, type Env } from "../helpers/extension.ts";

const COLD_MS = 180_000;
let env: Env;
let page: import("playwright").Page;

/** Elements inside (or being) `sel` that ClearScroll hid. */
const hiddenIn = (sel: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    return [el, ...el.querySelectorAll("*")].filter((e) => e.getAttribute("data-clearscroll") === "blurred").length;
  }, sel);

before(async () => {
  env = await launchExtension();
});
after(async () => {
  await env?.close();
});

test("text and picture verdicts combine per card; dogs are not hidden for \"cats\"", async () => {
  await setSettings(env, { topics: [{ id: "c", text: "cats", enabled: true }], images: true, imageDownloads: false, mode: "balanced" });
  await waitRegistered(env, true);
  page = await env.ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 1400 });
  await page.goto(`${env.base}/mixed.html`);

  // Positive controls first (they also wait for both models to load).
  await waitAttr(page, "#text", "blurred", COLD_MS);
  await waitAttr(page, "#img-pic", "blurred", COLD_MS);
  await waitAttr(page, "#both", "blurred", COLD_MS);
  await waitAttr(page, "#dyn", "blurred", COLD_MS);
  await waitAttr(page, "#cat-p p", "blurred", COLD_MS);
  // Let every pending verdict arrive before checking what must stay visible.
  await page.waitForTimeout(3000);

  assert.equal(await attr(page, "#none"), null, "neutral text, landscape: untouched");
  assert.equal(await attr(page, "#none-pic"), null);
  assert.equal(await attr(page, "#text-pic"), null, "a picture inside a card hidden by its text is not blurred separately");
  assert.equal(await attr(page, "#img"), null, "neutral text: the card stays visible …");
  assert.match(await page.evaluate(() => document.querySelector("#img p")!.textContent!), /Weekend weather/);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#img p")!).filter), "none", "… and its text is not blurred");
  assert.equal(await attr(page, "#both-pic"), null, "no nested blur inside a hidden card");
  for (const id of ["#none", "#dog-1", "#dog-2", "#dog-3"]) assert.equal(await hiddenIn(id), 0, `${id}: nothing inside is hidden (a dog text is not hidden for "cats")`);

  // One click reveals the whole card, picture included.
  await page.click("#both");
  await waitAttr(page, "#both", "revealed");
  assert.equal(await attr(page, "#both-pic"), null);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("both-pic")!).filter), "none", "the picture is visible after one reveal");

  // The card's text changes to something unrelated: its old verdict is dropped.
  await page.evaluate(() => (document.getElementById("dyn-text")!.textContent = "The library will close early on Thursday for staff training."));
  await waitAttr(page, "#dyn", null, 30_000);
  assert.equal(await attr(page, "#dyn-pic"), null);
});
