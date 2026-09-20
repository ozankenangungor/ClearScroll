import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { extensionPage, launchExtension, setSettings, waitAttr, waitRegistered, type Env } from "../helpers/extension.ts";
let env: Env;
before(async () => { env = await launchExtension(); });
after(async () => { await env?.close(); });

test("popup picker saves both feedback kinds without revealing, following links or capturing page content; export/delete", async () => {
  await setSettings(env, { engine: "off", topics: [{ id: "t", text: "cryptocurrency", enabled: true }] });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/csp/mixed.html`);
  // Public synthetic content, including sentinel secrets that must never enter feedback.
  await page.evaluate(() => { document.body.innerHTML = `<main><p id="hidden"><a href="/leave">cryptocurrency trading public item</a></p><p id="visible">The garden has flowers and a private-sentinel.</p><form><p id="secret">cryptocurrency password-sentinel</p><input value="input-sentinel"></form><p hidden>hidden-account-sentinel</p></main>`; });
  await waitAttr(page, "#hidden", "blurred");
  const ui = await extensionPage(env);
  const popup = await extensionPage(env, "popup/popup.html");
  // Popup must target the browsing tab, not this harness's extension page.
  const start = async () => {
    await popup.evaluate(async url => { const tab = (await chrome.tabs.query({})).find(t => t.url === url)!; const r = await chrome.tabs.sendMessage(tab.id!, { type: "tab:feedback" }); if (!r.ok) throw Error("picker unavailable"); }, page.url());
    // Closed shadow DOM is tested through user-facing controls via CDP's DOM piercing for the harness only.
  };
  const clickControl = async (name: string) => {
    // Keyboard interaction works with the closed shadow DOM without any testing backdoor.
    if (name === "save") { await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Space"); }
  };
  await start();
  await page.locator("#hidden").click();
  assert.equal(new URL(page.url()).pathname, "/csp/mixed.html");
  assert.equal(await page.locator("#hidden").getAttribute("data-clearscroll"), "blurred");
  // Selection focuses the topic. Tab: diagnostics → Save.
  await clickControl("save");
  await ui.waitForFunction(async () => (((await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback ?? []) as any[]).length === 1);
  await page.keyboard.press("Escape");
  await start();
  await page.locator("#visible").click();
  await clickControl("save");
  await ui.waitForFunction(async () => (((await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback ?? []) as any[]).length === 2);
  const records: any = await ui.evaluate(async () => (await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback);
  assert.deepEqual(records.map((r: any) => r.kind), ["wrongly-hidden", "should-hide"]);
  assert(!JSON.stringify(records).includes("sentinel"));
  assert(records.every((r: any) => r.diagnostics === null));
  await page.keyboard.press("Escape");
  await start();
  await page.locator("#secret").click();
  assert.equal((await ui.evaluate(async () => (await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback) as any[]).length, 2);
  await page.keyboard.press("Escape");
  await start();
  await page.locator("#visible").click();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await ui.waitForFunction(async () => (((await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback ?? []) as any[]).length === 3);
  const diagnosed: any = await ui.evaluate(async () => (await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback);
  assert.equal(diagnosed[2].diagnostics.analyzed, true);
  assert.match(diagnosed[2].diagnostics.path, /p:nth-of-type/);
  assert(!JSON.stringify(diagnosed).includes("sentinel"));
  await page.keyboard.press("Escape");
  await ui.reload();
  const downloaded = ui.waitForEvent("download");
  await ui.locator("#export-feedback").click();
  assert.equal((await downloaded).suggestedFilename(), "clearscroll-local-feedback.json");
  await ui.locator("#delete-feedback").click();
  await ui.waitForFunction(() => document.querySelector("#feedback-summary")?.textContent?.startsWith("0 local"));
  await Promise.all([page.close(), ui.close(), popup.close()]);
});

test("pending topic survives popup settings writes; keyboard reveals a nested link before activating", async () => {
  const ui = await extensionPage(env);
  await ui.locator("#new-topic").fill("pending subject");
  await setSettings(env, { enabled: false });
  await ui.waitForTimeout(200);
  assert.equal(await ui.locator("#new-topic").inputValue(), "pending subject");
  await ui.close();
  await setSettings(env, { enabled: true });
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/csp/mixed.html`);
  await page.evaluate(() => { document.body.innerHTML = '<p id="hidden">cryptocurrency <a href="/leave" id="link">trading public item</a></p>'; });
  await waitAttr(page, "#hidden", "blurred");
  await page.locator("#link").focus();
  await page.keyboard.press("Enter");
  await waitAttr(page, "#hidden", "revealed");
  assert.equal(new URL(page.url()).pathname, "/csp/mixed.html");
  await page.close();
});
