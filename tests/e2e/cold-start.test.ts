/**
 * Image sibling veto at cold start, end to end: a fresh browser, a page with
 * pictures only (so nothing has started the text engine), topic "football",
 * text engine preference "auto" (it tries WebGPU first, the slowest start).
 * The first pictures need the text engine's sibling plan while it is still
 * starting. The rugby photo (tests/fixtures/images/rugby-tackle.jpg) is hidden
 * for "football" by the rule without the veto; it must never be hidden here —
 * a picture is deferred ("plan-pending") rather than decided without the plan.
 *
 * Run `npm run build` first.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { attr, extensionPage, launchExtension, setSettings, waitAttr, waitRegistered, type Env } from "../helpers/extension.ts";

let env: Env;
before(async () => {
  env = await launchExtension();
});
after(async () => {
  await env?.close();
});

test("cold start: a rugby photo is not hidden for \"football\" while the text engine is still starting", async () => {
  await setSettings(env, { topics: [{ id: "f", text: "football", enabled: true }], images: true, imageDownloads: false, mode: "balanced", engine: "auto" });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`${env.base}/sports-pictures.html`);
  await waitAttr(page, "#football", "blurred", 180_000);
  // Every verdict, including deferred retries, has arrived.
  await page.waitForTimeout(5000);
  assert.equal(await attr(page, "#rugby"), null, "the rugby photo stays visible");
  const statsPage = await extensionPage(env);
  const stats = await statsPage.evaluate(() => chrome.runtime.sendMessage({ type: "off:vision-stats", target: "offscreen" }));
  await statsPage.close();
  assert.equal(stats.siblingTopics, 1, "the veto was active for \"football\"");
  console.log(`  deferred while the plan was pending: ${stats.skipped["plan-pending"] ?? 0}`);
});
