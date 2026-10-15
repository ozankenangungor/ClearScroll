/**
 * How long matching content stays visible on a live page: time from the
 * first element matching <content-selector> having text to the first hidden
 * element, measured in the page, on a cold engine (first page) and a warm
 * one (second page in the same browser).
 *
 *   npm run build && node scripts/live-latency.ts "<topic>" <url> "<content-selector>" [runs]
 *
 * Manual tool: it contacts third-party sites and is not run in CI. Results
 * depend on the machine and backend (headless Chrome usually has no
 * hardware WebGPU, so the CPU backend is measured).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchContext } from "../tests/helpers/extension.ts";

const [topic, url, selector, runsArg = "1"] = process.argv.slice(2);
if (!topic || !url || !selector) {
  console.error('usage: node scripts/live-latency.ts "<topic>" <url> "<content-selector>" [runs]');
  process.exit(2);
}

for (let run = 1; run <= Number(runsArg); run++) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-latency-"));
  const { ctx, sw } = await launchContext(profile, { browser: "chrome", extraArgs: ["--lang=en-US"] });
  try {
    await sw.evaluate(async (t) => chrome.storage.local.set({ clearscroll_settings: { schema: 2, enabled: true, mode: "balanced", engine: "auto", topics: [{ id: "t", text: t, enabled: true }], excludedSites: [], protectedSelectors: [] } }), topic);
    for (const phase of ["cold", "warm"]) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.addInitScript((sel) => {
        const w = window as unknown as { __t: { content: number | null; blur: number | null } };
        w.__t = { content: null, blur: null };
        new MutationObserver(() => {
          if (w.__t.content === null && document.querySelector(sel)?.textContent?.trim()) w.__t.content = performance.now();
          if (w.__t.blur === null && document.querySelector('[data-clearscroll="blurred"]')) w.__t.blur = performance.now();
        }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      }, selector);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-clearscroll="blurred"]', { timeout: 30_000 }).catch(() => {});
      const t = await page.evaluate(() => (window as unknown as { __t: { content: number | null; blur: number | null } }).__t);
      const engine = await sw.evaluate(() => chrome.runtime.sendMessage({ type: "off:status", target: "offscreen" })) as { backend: string | null };
      console.log(JSON.stringify({ run, phase, backend: engine?.backend ?? null, contentMs: t.content && Math.round(t.content), firstBlurMs: t.blur && Math.round(t.blur), visibleMs: t.content !== null && t.blur !== null ? Math.round(t.blur - t.content) : null }));
      await page.close();
    }
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
