import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { launchExtension, extensionPage, waitAttr, waitRegistered, getSettings } from "../helpers/extension.ts";

test("production: clean onboarding, visible site defaults, text modes, image capability removed and reversible controls", async () => {
  const env = await launchExtension();
  try {
    const ui = await extensionPage(env);
    await ui.setViewportSize({ width: 1280, height: 800 });
    await ui.waitForFunction(() => (document.querySelector('#excluded-sites') as HTMLTextAreaElement).value.includes('youtube.com'));
    const settings = await getSettings(env);
    assert.equal(settings, undefined, 'first-run defaults do not overwrite concurrent user saves');
    assert.equal(await ui.locator('#excluded-sites').inputValue(), 'youtube.com\nyoutu.be');
    assert.equal(await ui.locator('#topic-list li').count(), 0);
    await waitRegistered(env, false);
    assert.match(await ui.locator('#h-welcome').innerText(), /Choose what you see/);
    assert.equal(await ui.locator('#images').isVisible(), false);
    const screenshots = process.env.CS_SCREENSHOTS;
    async function shot(name: string, page = ui) {
      if (!screenshots) return;
      fs.mkdirSync(screenshots, { recursive: true });
      await page.screenshot({ path: path.join(screenshots, name + '.png') });
    }
    await shot('01-onboarding');
    await ui.locator('#new-topic').fill('cryptocurrency');
    await ui.locator('#add-topic').click();
    await ui.locator('details.advanced > summary').click();
    await ui.locator('#engine').selectOption('cpu');
    await ui.locator('#save').click();
    await waitRegistered(env, true);
    assert.equal((await getSettings(env)).topics[0].text, 'cryptocurrency');
    const registration = await env.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts())[0]);
    assert(registration?.excludeMatches?.includes('*://*.youtube.com/*'));
    const page = await env.ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const mode of ['precision', 'balanced', 'aggressive']) {
      await ui.locator(`input[name=mode][value=${mode}]`).check();
      await ui.locator('#save').click();
      await page.goto(env.base + '/csp/production.html');
      await waitAttr(page, '#crypto', 'blurred');
      assert.equal(await page.locator('#garden-1').getAttribute('data-clearscroll'), null);
    }
    await shot('02-filtered', page);
    await page.locator('#crypto').focus();
    await page.keyboard.press('Enter');
    await waitAttr(page, '#crypto', 'revealed');
    await shot('03-revealed', page);
    await ui.locator('#enabled').uncheck();
    await ui.locator('#save').click();
    await page.waitForFunction(() => !document.querySelector('[data-clearscroll]'));
    await ui.locator('#enabled').check();
    await ui.locator('#save').click();
    await waitAttr(page, '#crypto', 'blurred');
    // Stored legacy image opt-in cannot activate an omitted runtime.
    await env.sw.evaluate(async () => {
      const s = (await chrome.storage.local.get('clearscroll_settings')).clearscroll_settings as Record<string, unknown>;
      await chrome.storage.local.set({clearscroll_settings: {...s, images: true, imageDownloads: true}});
    });
    await ui.reload();
    await ui.waitForFunction(async () => ((await chrome.storage.local.get('clearscroll_settings')).clearscroll_settings as {images: boolean}).images === false);
    assert.equal((await getSettings(env)).imageDownloads, false);
    const status = await ui.evaluate(() => chrome.runtime.sendMessage({type: 'ui:status'}));
    assert.equal(status.vision.state, 'idle');
    const report = await ui.evaluate(() => chrome.runtime.sendMessage({type: 'feedback:list'}));
    assert.equal(report.records.length, 0);
    await ui.locator('#new-topic').scrollIntoViewIfNeeded();
    await shot('04-settings');
  } finally { await env.close(); }
});

test("production: an immediate first saved topic survives asynchronous install lifecycle", async () => {
  const env = await launchExtension();
  try {
    const { setSettings } = await import('../helpers/extension.ts');
    await setSettings(env, {engine:'off',topics:[{id:'early',text:'cryptocurrency',enabled:true}]});
    await waitRegistered(env, true);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await getSettings(env)).topics[0].id, 'early');
  } finally { await env.close(); }
});
