/** Rendered line breaks must not manufacture words or lose phrase boundaries. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { harnessPage, launch, settle, waitPending } from "../helpers/dom-page.ts";

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

test("BR separates words while formatting spans and WBR preserve word continuity", async () => {
  const page = await harnessPage(browser, `<main>
    <p>We watched a blue<br>moon tonight.</p>
    <p>Please use blue<span><br></span>print for the invitation.</p>
    <p>Please read the blue<b>print</b> before starting.</p>
    <p>Please read the blue<wbr>print before starting.</p>
    <p>The first line<br><br>and the next line.</p>
  </main>`);
  try {
    await page.evaluate(() => (window as any).harness.apply());
    await waitPending(page, 1);
    assert.deepEqual(await page.evaluate(() => (window as any).harness.pendingTexts()), [[
      "We watched a blue moon tonight.",
      "Please use blue print for the invitation.",
      "Please read the blueprint before starting.",
      "Please read the blueprint before starting.",
      "The first line and the next line.",
    ]]);
  } finally { await page.close(); }
});

test("inserting and removing BR invalidates a joined-word decision without rewriting page content", async () => {
  const page = await harnessPage(browser, `<main><p id="case">Please read the blue<span id="seam"></span>print before starting.</p></main>`);
  try {
    await page.evaluate(() => (window as any).harness.apply());
    await waitPending(page, 1);
    await page.evaluate(() => (window as any).harness.respond(0, "blueprint"));
    await settle(page);
    assert.equal(await page.locator("#case").getAttribute("data-clearscroll"), "blurred");
    await page.locator("#seam").evaluate(el => el.append(document.createElement("br")));
    await waitPending(page, 1);
    assert.deepEqual(await page.evaluate(() => (window as any).harness.pendingTexts()), [["Please read the blue print before starting."]]);
    await page.evaluate(() => (window as any).harness.respond(0, "blueprint"));
    await settle(page);
    assert.equal(await page.locator("#case").getAttribute("data-clearscroll"), null);
    assert.equal(await page.locator("#seam br").count(), 1, "extension preserves the page's line break");
    await page.locator("#seam br").evaluate(el => el.remove());
    await waitPending(page, 1);
    await page.evaluate(() => (window as any).harness.respond(0, "blueprint"));
    await settle(page);
    assert.equal(await page.locator("#case").getAttribute("data-clearscroll"), "blurred");
    await page.evaluate(() => (window as any).harness.controller.stop());
    assert.equal(await page.locator("#case").getAttribute("data-clearscroll"), null);
    assert.equal(await page.locator("#seam").innerHTML(), "");
  } finally { await page.close(); }
});
