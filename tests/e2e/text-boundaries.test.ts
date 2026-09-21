/** Actual lexical decisions follow rendered BR boundaries, without changing inline words. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionPage, launchExtension, setSettings, waitRegistered } from "../helpers/extension.ts";

test("line breaks preserve phrases and do not manufacture lexical matches", async () => {
  const env = await launchExtension();
  try {
    const ui = await extensionPage(env);
    const cases = [
      { topic: "blue moon", html: "We watched a blue<br>moon tonight.", matched: true },
      { topic: "blueprint", html: "Please use blue<br>print for the invitation.", matched: false },
      { topic: "blueprint", html: "Please read the blue<b>print</b> before starting.", matched: true },
      { topic: "blueprint", html: "Please read the blue<wbr>print before starting.", matched: true },
    ];
    for (const c of cases) {
      await setSettings(env, { enabled: true, engine: "off", mode: "balanced", topics: [{ id: "t", text: c.topic, enabled: true }], images: false, imageDownloads: false });
      await waitRegistered(env, true);
      const page = await env.ctx.newPage();
      await page.route("**/text-boundaries.html", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><main><p id="case">${c.html}</p></main>` }));
      await page.goto(env.base + "/text-boundaries.html");
      let analyzed = false;
      for (let i = 0; i < 100; i++) {
        const state: any = await ui.evaluate(async url => {
          const tab = (await chrome.tabs.query({})).find(t => t.url === url)!;
          return chrome.tabs.sendMessage(tab.id!, { type: "tab:state" });
        }, page.url()).catch(() => null);
        if (state?.analyzed >= 1) { analyzed = true; break; }
        await page.waitForTimeout(100);
      }
      assert(analyzed, "decision must settle before checking visibility");
      assert.equal(await page.locator("#case").getAttribute("data-clearscroll") === "blurred", c.matched, c.html);
      assert.equal(await page.locator("#case").innerHTML(), c.html, "page content is never rewritten");
      await page.close();
    }
  } finally { await env.close(); }
});
