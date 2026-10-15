/**
 * End-to-end tests: the built extension (dist/) in real Chromium, including
 * the background service worker, offscreen document, WebAssembly engine and
 * the real MiniLM model. Run `npm run build` first.
 *
 * Headless Chromium only exposes a software WebGPU adapter (SwiftShader), so
 * the default path here is the CPU backend. GPU behaviour is covered by the
 * canary test below and by the optional native GPU test (tests/gpu_parity.rs).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { attr, extensionPage, getSettings, launchExtension, setSettings, uiStatus, waitAttr, waitRegistered, type Env } from "../helpers/extension.ts";

let env: Env;
const crypto = [{ id: "t-crypto", text: "cryptocurrency", enabled: true }];

before(async () => {
  env = await launchExtension();
});
after(async () => {
  await env?.close();
});

async function reset(patch: Record<string, unknown> = {}) {
  await env.sw.evaluate(() => chrome.storage.local.clear());
  await setSettings(env, { topics: [], ...patch });
  await waitRegistered(env, false);
  for (const p of env.ctx.pages()) await p.close();
}

test("a match hides the whole feed item: video cards, shadow-DOM posts and timeline posts", async () => {
  await reset();
  await setSettings(env, { topics: [{ id: "t-football", text: "football", enabled: true }] });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(`${env.base}/feeds.html`);
  // Video card: the card (with its thumbnail, metadata and channel row) is hidden, not just the title.
  await waitAttr(page, "#v1", "blurred");
  assert.equal(await attr(page, "#v1-title"), null, "the title is hidden through its card");
  assert.match(await page.evaluate(() => getComputedStyle(document.getElementById("v1")!).filter), /blur/);
  // Post component with a shadow root: the host element is hidden, so slotted thumbnail and shadow content go with it.
  await waitAttr(page, "#r1", "blurred");
  // Timeline post with an attached image.
  await waitAttr(page, "#x1", "blurred");
  await page.waitForTimeout(500);
  for (const id of ["v2", "v3", "r2", "r3", "x2"]) assert.equal(await attr(page, `#${id}`), null, `${id} is unrelated and stays visible`);
  assert.equal(await page.locator("main [data-clearscroll]").count(), 3, "only the three football items are touched");
  // One click on the hidden thumbnail reveals the whole card without following its link.
  await page.click("#v1", { position: { x: 60, y: 60 } });
  assert.equal(await attr(page, "#v1"), "revealed");
  assert.equal(await page.evaluate(() => location.hash), "");
});

test("installs cleanly: manifest, service worker, no registration without topics", async () => {
  const manifest = await env.sw.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.name, "ClearScroll");
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.web_accessible_resources, undefined, "no resources are exposed to web pages");
  assert.deepEqual([...manifest.permissions!].sort(), ["offscreen", "scripting", "storage"]);
  await reset();
  const offscreen = await env.sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })).length);
  assert.equal(offscreen, 0, "model is not loaded while filtering is inactive");
});

test("semantic filtering blurs related content and leaves unrelated content visible", async () => {
  await reset();
  await setSettings(env, { topics: crypto });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  await page.waitForTimeout(500);
  assert.equal(await attr(page, "#garden-1 h2"), null);
  assert.equal(await attr(page, "#bakery-1-body"), null);
  assert.equal(await attr(page, "#museum-1-body"), null);
  assert.equal(await attr(page, "#crypto-1 .meta"), null, "short metadata labels are not classified semantically");
  // Protected UI: the form mentions crypto but must never be touched.
  assert.equal(await page.locator("form [data-clearscroll]").count(), 0);
  const status = await uiStatus(env);
  assert.equal(status.engine.state, "semantic");
  assert.equal(status.engine.backend, "cpu");
  assert.equal(status.engine.model, "minilm-l6");
  assert.equal(status.registration.registered, true);
});

test("works on pages with a strict Content-Security-Policy", async () => {
  const page = await env.ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${env.base}/csp/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  assert.equal(await attr(page, "#garden-1 h2"), null);
  assert.deepEqual(errors.filter((e) => /clearscroll|content security/i.test(e)), []);
});

test("dynamic feeds: client-rendered posts and in-place edits are classified", async () => {
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/feed.html`);
  await page.waitForSelector("body[data-feed-done]");
  await waitAttr(page, "#p1", "blurred");
  await waitAttr(page, "#p3", "blurred");
  await waitAttr(page, "#p5", "blurred"); // was neutral, edited to crypto
  assert.equal(await attr(page, "#p2"), null);
  assert.equal(await attr(page, "#p4"), null);
});

test("clicking reveals one item without disabling filtering", async () => {
  for (const p of env.ctx.pages()) await p.close();
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  await page.click("#crypto-1 h2");
  assert.equal(await attr(page, "#crypto-1 h2"), "revealed");
  const state = await env.sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: url + "/*" });
    return chrome.tabs.sendMessage(tab!.id!, { type: "tab:state" });
  }, env.base);
  assert.equal(state.activity, "active");
  assert.equal(state.revealed, 1);
});

test("changing the topic re-analyses open pages", async () => {
  await reset();
  await setSettings(env, { topics: crypto });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  await setSettings(env, { topics: [{ id: "t-foot", text: "football", enabled: true }] });
  await waitAttr(page, "#sport-1-body", "blurred");
  await waitAttr(page, "#crypto-1 h2", null);
});

test("pausing clears blur everywhere and unloads the model", async () => {
  await reset();
  await setSettings(env, { topics: crypto });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  await setSettings(env, { enabled: false });
  await waitAttr(page, "#crypto-1 h2", null);
  await waitRegistered(env, false);
  const offscreen = await env.sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })).length);
  assert.equal(offscreen, 0);
});

test("tabs opened before filtering was enabled are filtered without a reload", async () => {
  await reset();
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await page.waitForTimeout(300);
  assert.equal(await page.locator("[data-clearscroll]").count(), 0);
  await setSettings(env, { topics: crypto });
  await waitAttr(page, "#crypto-1 h2", "blurred");
});

test("excluded sites are not touched; removing the rule re-enables them", async () => {
  await reset();
  await setSettings(env, { topics: crypto, excludedSites: ["127.0.0.1"] });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await page.waitForTimeout(1500);
  assert.equal(await page.locator("[data-clearscroll]").count(), 0);
  const injected = await page.evaluate(() => document.querySelectorAll("[data-clearscroll]").length);
  assert.equal(injected, 0);
  const registered = await env.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts())[0]?.excludeMatches);
  assert.deepEqual(registered, ["*://127.0.0.1/*"]);
  await setSettings(env, { excludedSites: [] });
  await waitAttr(page, "#crypto-1 h2", "blurred");
  // Adding the exclusion back stops filtering in the already-open tab.
  await setSettings(env, { excludedSites: ["127.0.0.1"] });
  await waitAttr(page, "#crypto-1 h2", null);
});

test("cold start with concurrent tabs: every on-screen unit is analysed (regression)", async () => {
  // Two tabs requesting the engine at the same moment used to race on
  // offscreen creation; the losing tab's units were then never retried.
  await reset();
  await setSettings(env, { topics: crypto });
  await waitRegistered(env, true);
  const warnings: string[] = [];
  const pages = await Promise.all([0, 1].map(() => env.ctx.newPage()));
  for (const p of pages) p.on("console", (m) => /classify failed/.test(m.text()) && warnings.push(m.text()));
  await Promise.all(pages.map((p) => p.goto(`${env.base}/long.html`)));
  for (const p of pages) {
    await p.bringToFront();
    await p.waitForFunction(() => document.querySelectorAll('[data-clearscroll="blurred"]').length >= 5, null, { timeout: 30_000 });
  }
  const counts = () =>
    env.sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url: url + "/long.html" });
      return Promise.all(tabs.map(async (t) => (await chrome.tabs.sendMessage(t.id!, { type: "tab:state" })).analyzed as number));
    }, env.base);
  // Units within the controller's look-ahead window (±1.5 viewports).
  const expected = await pages[0]!.evaluate(() => {
    const h = innerHeight;
    return [...document.querySelectorAll("main p")].filter((p) => {
      const r = p.getBoundingClientRect();
      return r.bottom >= -1.5 * h && r.top <= 2.5 * h;
    }).length;
  });
  assert.ok(expected > 20, `fixture should have many on-screen units (got ${expected})`);
  let analysed = await counts();
  for (let i = 0; i < 60 && analysed.some((n) => n < expected); i++) {
    await new Promise((r) => setTimeout(r, 250));
    analysed = await counts();
  }
  assert.equal(analysed.length, 2);
  for (const n of analysed) assert.ok(n >= expected, `only ${n} of ${expected} on-screen units analysed`);
  assert.deepEqual(warnings, [], "no failed classification requests");
});

test("several tabs share a single engine instance", async () => {
  await reset();
  await setSettings(env, { topics: crypto });
  await waitRegistered(env, true);
  const pages = await Promise.all([0, 1, 2].map(() => env.ctx.newPage()));
  await Promise.all(pages.map((p, i) => p.goto(`${env.base}/${i === 1 ? "feed" : "news"}.html`)));
  await Promise.all(pages.map((p, i) => waitAttr(p, i === 1 ? "#p1" : "#crypto-1 h2", "blurred")));
  const offscreen = await env.sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })).length);
  assert.equal(offscreen, 1);
});

test("keyword-only mode reports itself honestly and still filters explicit mentions", async () => {
  await reset();
  await setSettings(env, { topics: [{ id: "k", text: "bitcoin", enabled: true }], engine: "off" });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  assert.equal(await attr(page, "#crypto-2-body"), null, "no keyword → not hidden without the model");
  const status = await uiStatus(env);
  assert.equal(status.engine.state, "lexical-fallback");
});

test("a GPU returning wrong results is detected and replaced by the CPU engine", async (t) => {
  const hasAdapter = await env.sw.evaluate(async () => !!(await (navigator as any).gpu?.requestAdapter()));
  if (!hasAdapter) {
    t.skip("no WebGPU adapter in this environment");
    return;
  }
  await reset();
  await setSettings(env, { topics: crypto, engine: "auto" });
  await waitRegistered(env, true);
  // Force the software adapter (normally skipped) to exercise the safety net.
  const result = await env.sw.evaluate(async () => {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen/offscreen.html?backend=auto&allowFallbackAdapter=1"),
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification: "test",
    });
    return chrome.runtime.sendMessage({
      type: "off:classify", target: "offscreen", frameKey: "test", generation: 1, mode: "balanced",
      topics: [{ id: "c", text: "cryptocurrency" }],
      texts: ["Bitcoin climbs above $70,000 as ETF inflows accelerate", "How to keep tomato plants healthy during a heatwave"],
    });
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.decisions.map((d: any) => d.matched), [true, false]);
  assert.equal(result.engine.state, "semantic");
  // Either the software GPU failed a check and CPU took over, or it computed correctly.
  if (result.engine.backend === "cpu") assert.match(result.engine.detail, /webgpu: .*(canary|self-test)/);
  await env.sw.evaluate(() => chrome.offscreen.closeDocument());
});

test("options page: validation blocks bad input, valid settings persist", async () => {
  await reset();
  const page = await extensionPage(env);
  await page.fill("#new-topic", "movie spoilers");
  await page.click("#add-topic");
  await page.fill("#new-topic", "Movie   SPOILERS");
  await page.click("#add-topic");
  assert.match(await page.locator("#new-topic-error").innerText(), /already exists/);
  await page.fill("#new-topic", "");
  await page.locator("input[name=mode][value=aggressive]").check();
  await page.fill("#excluded-sites", "example.com\n*bad.com");
  await page.click("summary");
  await page.fill("#protected-selectors", ".ok\ndiv[[");
  await page.click("#save");
  assert.match(await page.locator("#save-status").innerText(), /Not saved/);
  assert.match(await page.locator("#sites-error").innerText(), /\*bad\.com/);
  assert.match(await page.locator("#selectors-error").innerText(), /div\[\[/);
  assert.equal((await getSettings(env)).topics.length, 0, "nothing saved while invalid");

  await page.fill("#excluded-sites", "https://Example.com/path\nnews.example.com");
  await page.fill("#protected-selectors", ".ok");
  await page.click("#save");
  assert.match(await page.locator("#save-status").innerText(), /Saved/);
  const s = await getSettings(env);
  assert.deepEqual(s.topics.map((t: any) => t.text), ["movie spoilers"]);
  assert.equal(s.mode, "aggressive");
  assert.deepEqual(s.excludedSites, ["example.com", "news.example.com"]);
  assert.deepEqual(s.protectedSelectors, [".ok"]);

  await page.reload();
  assert.equal(await page.locator("#topic-list input[type=text]").inputValue(), "movie spoilers");
  assert.equal(await page.locator("input[name=mode][value=aggressive]").isChecked(), true);
  await page.close();
});

test("popup reports the page state and can exclude the current site", async () => {
  await reset();
  await setSettings(env, { topics: crypto, engine: "cpu" });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  await page.bringToFront();
  // Opening the real action popup is not automatable; load popup.html in a tab
  // and point it at the news tab via chrome.tabs.query's active tab.
  const popup = await env.ctx.newPage();
  await popup.goto(`chrome-extension://${env.extId}/popup/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.waitForFunction(() => /hidden/.test(document.getElementById("site-state")!.textContent ?? ""));
  assert.equal(await popup.locator("#site-host").innerText(), "127.0.0.1");
  await popup.click("#toggle-site");
  await waitAttr(page, "#crypto-1 h2", null);
  assert.deepEqual((await getSettings(env)).excludedSites, ["127.0.0.1"]);
});

test("options page: a typed-but-invalid topic blocks saving instead of being dropped", async () => {
  await reset();
  const page = await extensionPage(env);
  await page.fill("#new-topic", "x"); // too short
  await page.click("#save");
  assert.match(await page.locator("#save-status").innerText(), /Not saved/);
  assert.match(await page.locator("#new-topic-error").innerText(), /too short/);
  assert.equal((await getSettings(env)).topics.length, 0);
  await page.close();
});

test("options page: legacy site rules that could not be migrated are shown and can be dismissed", async () => {
  await reset();
  await env.sw.evaluate(() =>
    chrome.storage.local.set({ clearscroll_migration_notes: { droppedSites: [{ input: "*bank*.com", error: 'wildcards are only allowed as a leading "*."' }] } })
  );
  const page = await extensionPage(env);
  await page.waitForSelector("#migration-notes:not([hidden])");
  assert.match(await page.locator("#migration-list").innerText(), /\*bank\*\.com/);
  await page.click("#dismiss-migration");
  assert.equal(await page.locator("#migration-notes").isHidden(), true);
  const left = await env.sw.evaluate(async () => (await chrome.storage.local.get("clearscroll_migration_notes")).clearscroll_migration_notes);
  assert.equal(left, undefined);
  await page.close();
});

test("background migrates IdeaBlocker settings and records unconvertible site rules", async () => {
  await reset();
  await env.sw.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      ideablocker_settings: { target: "crypto and web3", mode: "balanced", excludedSites: ["chatgpt.com", "*bank*.com"], protectedSelectors: [] },
      ideablocker_target: "crypto and web3",
    });
  });
  const page = await extensionPage(env);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "ui:status" }));
  const stored: any = await env.sw.evaluate(() => chrome.storage.local.get(null));
  assert.deepEqual(stored.clearscroll_settings.topics.map((t: { text: string }) => t.text), ["crypto and web3"]);
  assert.equal(stored.clearscroll_settings.mode, "balanced");
  assert.deepEqual(stored.clearscroll_settings.excludedSites, ["chatgpt.com"]);
  assert.deepEqual(stored.clearscroll_migration_notes.droppedSites.map((d: { input: string }) => d.input), ["*bank*.com"]);
  assert.equal(stored.ideablocker_settings, undefined, "legacy keys removed");
  assert.equal(stored.ideablocker_target, undefined);
  await page.reload();
  await page.waitForSelector("#migration-notes:not([hidden])");
  await page.close();
});
