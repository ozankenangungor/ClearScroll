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

test("feedback storage cleanup, worker restart and explicit UTF-8 schema export remain bounded and content-free", async () => {
  const ui = await extensionPage(env);
  const now = Date.now();
  const record = { kind: "should-hide", topicId: "t", topic: '猫 🐈 <script>literal</script>', mode: "balanced", decision: "visible", target: { tag: "p", ordinal: 1 }, diagnostics: null, version: "0.3.1", reviewStatus: "unreviewed-user-report", createdAt: now };
  const rows: object[] = Array.from({ length: 105 }, (_, i) => ({ ...record, id: crypto.randomUUID(), createdAt: now - 1000 + i, pageText: "private-message-sentinel", cookies: "auth-token-sentinel" }));
  rows.push({ ...record, id: crypto.randomUUID(), createdAt: now - 30 * 86400_000 }, { ...record, id: "malformed", createdAt: now });
  let downloads = 0;
  ui.on("download", () => downloads++);
  await ui.evaluate(records => chrome.storage.local.set({ clearscroll_feedback: records }), rows);
  await ui.waitForFunction(async () => ((await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback as any[])?.length === 100);
  assert.equal(downloads, 0, "storage writes and UI refresh never export automatically");
  const cdp = await env.ctx.newCDPSession(ui);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  // An options request wakes a real replacement service worker.
  const reply: any = await ui.evaluate(() => chrome.runtime.sendMessage({ type: "feedback:list" }));
  assert(reply.ok);
  assert.equal(reply.records.length, 100);
  const download = ui.waitForEvent("download");
  await ui.locator("#export-feedback").click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  const data = JSON.parse(raw);
  assert.equal(data.schema, 1);
  assert.equal(new Date(data.exportedAt).toISOString(), data.exportedAt);
  assert.equal(data.records.length, 100);
  assert.equal(data.records[0].topic, record.topic);
  assert.deepEqual(Object.keys(data.records[0]).sort(), ["createdAt", "decision", "diagnostics", "id", "kind", "mode", "reviewStatus", "target", "topic", "topicId", "version"].sort());
  assert(!/sentinel|auth-token/.test(raw));
  assert.equal(downloads, 1);
  assert.equal(await ui.locator("#feedback-list script").count(), 0, "topic is rendered as literal text");
  await ui.locator("#delete-feedback").click();
  await ui.waitForFunction(() => document.querySelector("#feedback-summary")?.textContent?.startsWith("0 local"));
  assert.equal(await ui.evaluate(async () => ((await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback as any[] | undefined)?.length ?? 0), 0);
  await ui.close();
});

test("picker preserves selected topic for repeated reports; custom-tag diagnostics are redacted and detached targets cannot save", async () => {
  // Reacquire the current worker after the previous test deliberately stopped it.
  env.sw = env.ctx.serviceWorkers().find(w => w.url().startsWith(`chrome-extension://${env.extId}/`))!;
  await setSettings(env, { engine: "off", topics: [{ id: "t", text: "cryptocurrency", enabled: true }, { id: "c", text: "cats", enabled: true }] });
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/csp/mixed.html`);
  await page.evaluate(() => { document.body.innerHTML = '<authabc123secret style="display:block"><p id="target">The public garden flowers bloom.</p></authabc123secret>'; });
  const popup = await extensionPage(env, "popup/popup.html");
  const ui = await extensionPage(env);
  const start = async () => popup.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(t => t.url === url)!;
    const r = await chrome.tabs.sendMessage(tab.id!, { type: "tab:feedback" });
    if (!r.ok) throw Error("picker unavailable");
  }, page.url());
  for (let i = 1; i <= 2; i++) {
    await start(); await page.locator("#target").click();
    await page.keyboard.press("End"); // Select the second enabled topic.
    await page.keyboard.press("Tab"); await page.keyboard.press("Space");
    await page.keyboard.press("Tab"); await page.keyboard.press("Space");
    await ui.waitForFunction(async n => ((await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback as any[])?.length === n, i);
    await page.keyboard.press("Escape");
  }
  const records: any = await ui.evaluate(async () => (await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback);
  assert(records.every((r: any) => r.topicId === "c" && r.topic === "cats" && r.target.tag === "p" && r.target.ordinal === 1));
  assert.notEqual(records[0].id, records[1].id);
  assert(!JSON.stringify(records).includes("authabc123secret"));
  assert.match(records[0].diagnostics.path, /element:nth-of-type/);
  await start(); await page.locator("#target").click();
  await page.evaluate(() => document.querySelector("#target")!.remove());
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  assert.equal((await ui.evaluate(async () => (await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback) as any[]).length, 2);
  await page.keyboard.press("Escape");
  await ui.locator("#delete-feedback").click();
  await Promise.all([page.close(), popup.close(), ui.close()]);
});
