/**
 * Accessibility checks with axe-core (WCAG 2.0/2.1 A and AA rules) on the
 * extension's own pages and on a web page with ClearScroll's blur applied,
 * plus keyboard, focus-visibility and reduced-motion behaviour.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import fs from "node:fs";
import type { Page } from "playwright";

import { extensionPage, launchExtension, setSettings, waitAttr, waitRegistered, type Env } from "../helpers/extension.ts";

const AXE = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

let env: Env;
before(async () => {
  env = await launchExtension();
});
after(async () => {
  await env?.close();
});

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

/** Run axe; `include` limits the audit (e.g. to blurred elements on a third-party page). */
async function axe(page: Page, include?: string): Promise<AxeViolation[]> {
  // Extension pages forbid inline scripts (CSP script-src 'self'), so a
  // <script> tag is blocked; DevTools-protocol evaluation is not subject to it.
  await page.evaluate(AXE);
  return page.evaluate(
    async ({ tags, include }) => {
      const r = await (window as any).axe.run(include ? { include: [include] } : document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
      return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n: any) => ({ target: n.target })) }));
    },
    { tags: TAGS, include }
  );
}

const describe = (vs: AxeViolation[]) => vs.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`).join("\n");

async function seedOptions(): Promise<void> {
  await env.sw.evaluate(() => chrome.storage.local.clear());
  await setSettings(env, {
    topics: [
      { id: "a", text: "cryptocurrency", enabled: true },
      { id: "b", text: "movie spoilers", enabled: false },
    ],
    excludedSites: ["example.com"],
  });
  await env.sw.evaluate(() =>
    chrome.storage.local.set({ clearscroll_migration_notes: { droppedSites: [{ input: "*bank*.com", error: "wildcards are only allowed as a leading *." }] } })
  );
}

for (const scheme of ["light", "dark"] as const) {
  test(`options page has no WCAG A/AA violations (${scheme} mode, all states)`, async () => {
    await seedOptions();
    const page = await extensionPage(env);
    await page.emulateMedia({ colorScheme: scheme });
    await page.reload();
    await page.waitForSelector("#migration-notes:not([hidden])");
    // Show error states and the Advanced section too.
    await page.fill("#new-topic", "x");
    await page.click("#add-topic");
    await page.fill("#excluded-sites", "*bad.com");
    await page.click("summary");
    await page.fill("#protected-selectors", "div[[");
    await page.click("#save");
    await page.waitForTimeout(300);
    const v = await axe(page);
    assert.deepEqual(v, [], describe(v));
    await page.close();
  });

  test(`popup has no WCAG A/AA violations (${scheme} mode)`, async () => {
    await seedOptions();
    const popup = await env.ctx.newPage();
    await popup.emulateMedia({ colorScheme: scheme });
    await popup.goto(`chrome-extension://${env.extId}/popup/popup.html`);
    await popup.waitForTimeout(500);
    const v = await axe(popup);
    assert.deepEqual(v, [], describe(v));
    await popup.close();
  });
}

test("blurred items on a web page introduce no WCAG A/AA violations", async () => {
  await env.sw.evaluate(() => chrome.storage.local.clear());
  await setSettings(env, { topics: [{ id: "c", text: "cryptocurrency", enabled: true }] });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  // Audit only what ClearScroll changed; the fixture page itself is not ours.
  const v = await axe(page, '[data-clearscroll]');
  assert.deepEqual(v, [], describe(v));
  await page.close();
});

test("keyboard: every options control is reachable with Tab and shows a visible focus indicator", async () => {
  await seedOptions();
  const page = await extensionPage(env);
  await page.click("summary"); // open Advanced so its controls are in the tab order
  await page.locator("body").focus();
  const expected = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("input, select, textarea, button, summary")]
      .filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled)
      .map((el) => el.id || el.getAttribute("aria-label") || el.textContent!.trim())
  );
  const reached: string[] = [];
  const missingOutline: string[] = [];
  for (let i = 0; i < expected.length + 5; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      return { name: el.id || el.getAttribute("aria-label") || el.textContent!.trim(), outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2 };
    });
    if (!info) continue;
    if (!reached.includes(info.name)) reached.push(info.name);
    if (!info.outline) missingOutline.push(info.name);
  }
  for (const name of expected) assert.ok(reached.includes(name), `not reachable by keyboard: ${name}`);
  assert.deepEqual([...new Set(missingOutline)], [], "focused controls without a visible outline");
  await page.close();
});

test("blurred items are keyboard-focusable with a visible focus ring; reduced motion disables the transition", async () => {
  await env.sw.evaluate(() => chrome.storage.local.clear());
  await setSettings(env, { topics: [{ id: "c", text: "cryptocurrency", enabled: true }] });
  await waitRegistered(env, true);
  const page = await env.ctx.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${env.base}/news.html`);
  await waitAttr(page, "#crypto-1 h2", "blurred");
  await page.locator("body").focus();
  let found = false;
  for (let i = 0; i < 20 && !found; i++) {
    await page.keyboard.press("Tab");
    found = await page.evaluate(() => document.activeElement?.getAttribute("data-clearscroll") === "blurred");
  }
  assert.ok(found, "a blurred item is reachable with Tab");
  const style = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement!);
    return { outline: s.outlineStyle, width: parseFloat(s.outlineWidth), transition: s.transitionDuration };
  });
  assert.notEqual(style.outline, "none");
  assert.ok(style.width >= 2);
  assert.equal(style.transition, "0s");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-clearscroll")), "revealed");
  await page.close();
});
