/**
 * Capture how the built extension treats a live public page: load it in
 * Google Chrome stable with the extension, decline any cookie dialog (it
 * locks scrolling), scroll so lazily loaded items render, wait until the
 * number of analysed units settles, then save screenshots and every text
 * unit the content script considers (dom.ts collectUnits/unitText) with its
 * visual state and the card it belongs to (dom.ts itemOf). Used to collect
 * eval/realworld (verdicts discarded before labelling).
 *
 *   npm run build && node scripts/live-capture.ts <out-dir> <label> "<topic>|<topic>|-" <url> [mode]
 *
 * Manual tool: it contacts third-party sites and is not run in CI. Pages
 * that block automated browsers are reported as such; nothing is bypassed.
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchContext } from "../tests/helpers/extension.ts";

const [outDir, label, topicArg, url, mode = "balanced"] = process.argv.slice(2);
if (!outDir || !label || !topicArg || !url) {
  console.error('usage: node scripts/live-capture.ts <out-dir> <label> "<topic>|<topic>|-" <url> [mode]');
  process.exit(2);
}
const topics = topicArg === "-" ? [] : topicArg.split("|").map((t, i) => ({ id: `t${i}`, text: t, enabled: true }));
const DOM = (await esbuild.build({ entryPoints: [path.resolve(import.meta.dirname, "../src/content/dom.ts")], bundle: true, write: false, format: "iife", globalName: "CSDom" })).outputFiles[0]!.text;

fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-live-"));
const { ctx, sw } = await launchContext(profile, { browser: "chrome", extraArgs: ["--lang=en-US"] });
try {
  await sw.evaluate(async (s) => chrome.storage.local.set({ clearscroll_settings: s }), {
    schema: 2, enabled: topics.length > 0, mode, engine: "auto", topics, excludedSites: [], protectedSelectors: [],
  });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const w = window as unknown as { __csFirstBlur: number | null };
    w.__csFirstBlur = null;
    new MutationObserver(() => {
      if (w.__csFirstBlur === null && document.querySelector('[data-clearscroll="blurred"]')) w.__csFirstBlur = performance.now();
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-clearscroll"] });
  });
  const t0 = Date.now();
  const status = (await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }))?.status();
  await page.waitForTimeout(2500);
  // Decline (or, if that is not offered, accept) cookie dialogs as a user would.
  let consent = "none";
  outer: for (const name of [/^(no,? thank you|reject all|reject)/i, /^(yes, i accept|yes, i.m happy|accept all|accept|i agree|agree|allow all)/i]) {
    for (const f of page.frames()) {
      const b = f.getByRole("button", { name }).first();
      if (await b.isVisible().catch(() => false)) {
        await b.click().catch(() => {});
        consent = String(name);
        break outer;
      }
    }
  }
  await page.waitForTimeout(1500);
  const tabState = () =>
    sw.evaluate(async (u) => {
      const [tab] = await chrome.tabs.query({ url: u.split("#")[0] + "*" });
      return tab?.id ? chrome.tabs.sendMessage(tab.id, { type: "tab:state" }).catch(() => null) : null;
    }, page.url()) as Promise<{ analyzed: number; blurred: number } | null>;
  await page.screenshot({ path: path.join(outDir, `${label}-top.png`) });
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < Math.min(height, 900 * 14); y += 700) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await page.waitForTimeout(500);
  }
  let last = -1, stable = 0, state: Awaited<ReturnType<typeof tabState>> = null;
  for (let i = 0; i < 60 && stable < 4; i++) {
    await page.waitForTimeout(500);
    state = await tabState();
    if (state?.analyzed === last) stable++;
    else { stable = 0; last = state?.analyzed ?? -1; }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, `${label}-top-after-scroll.png`) });
  const units = await page.evaluate(DOM + `;(() => {
    const sel = CSDom.compileProtectedSelector([]);
    const set = new Set(); CSDom.collectUnits(document.body, sel, set);
    const out = [];
    const cards = new Map();
    for (const u of set) {
      const text = CSDom.unitText(u, sel);
      const r = u.getBoundingClientRect();
      if (!text || r.width === 0 || r.height === 0) continue;
      const shown = u.closest('[data-clearscroll]');
      // The element a match would hide (dom.ts itemOf): its card, or the text itself.
      const item = CSDom.itemOf(u, sel) ?? u;
      if (!cards.has(item)) cards.set(item, "c" + cards.size);
      out.push({ text, state: shown ? shown.getAttribute("data-clearscroll") : "", card: cards.get(item) });
    }
    return out;
  })()`) as { text: string; state: string; card: string }[];
  const firstBlurMs = await page.evaluate(() => (window as unknown as { __csFirstBlur: number | null }).__csFirstBlur);
  const summary = { label, url, status, consent, topics: topics.map((t) => t.text), mode, firstBlurMs: firstBlurMs && Math.round(firstBlurMs), analyzed: state?.analyzed ?? null, units: units.length, hiddenUnits: units.filter((u) => u.state === "blurred").length, totalMs: Date.now() - t0 };
  fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify({ ...summary, captured: new Date().toISOString().slice(0, 10), unitList: units }, null, 1));
  console.log(JSON.stringify(summary));
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
