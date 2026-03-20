/**
 * Live-site check of image filtering (manual, needs internet; not run in CI).
 *
 *   node scripts/live-vision.ts [--downloads] [--browser chrome] [--out build/ux-evidence/vision]
 *
 * Loads public pages with the built extension, image filtering on, and
 * reports per page: pictures seen, analysed, hidden by image analysis,
 * cards hidden by text, and pictures skipped (with reasons). Screenshots are
 * written to the (git-ignored) output directory for local review only —
 * third-party page content, not for publication.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DIST, launchContext } from "../tests/helpers/extension.ts";

const downloads = process.argv.includes("--downloads");
const browser = (process.argv.includes("--browser") ? process.argv[process.argv.indexOf("--browser") + 1] : "chromium") as "chromium" | "chrome";
const OUT = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : "build/ux-evidence/vision");
fs.mkdirSync(OUT, { recursive: true });

const PAGES: { name: string; url: string; topic: string }[] = [
  { name: "youtube-animals", url: "https://www.youtube.com/results?search_query=funny+animal+compilation", topic: "cats" },
  { name: "youtube-sport", url: "https://www.youtube.com/results?search_query=sports+highlights", topic: "football" },
  { name: "bbc-sport", url: "https://www.bbc.com/sport", topic: "football" },
  { name: "guardian-uk", url: "https://www.theguardian.com/uk", topic: "football" },
  { name: "commons-cats", url: "https://commons.wikimedia.org/wiki/Category:Quality_images_of_cats", topic: "cats" },
  { name: "commons-dogs", url: "https://commons.wikimedia.org/wiki/Category:Quality_images_of_dogs", topic: "cats" },
];

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-live-vision-"));
const { ctx, sw } = await launchContext(profile, { browser, dist: DIST });
const results: unknown[] = [];
try {
  for (const p of PAGES) {
    await sw.evaluate(
      async ({ topic, downloads }) =>
        chrome.storage.local.set({ clearscroll_settings: { schema: 2, enabled: true, mode: "precision", engine: "cpu", topics: [{ id: "t", text: topic, enabled: true }], excludedSites: [], protectedSelectors: [], images: true, imageDownloads: downloads } }),
      { topic: p.topic, downloads }
    );
    await new Promise((r) => setTimeout(r, 700));
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 1600 });
    try {
      await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      // Consent walls (EU) are not clicked through: their content is reported as is.
      await page.waitForTimeout(40_000);
      // One web page is open at a time.
      const tab = await sw.evaluate(async () => {
        const [t] = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
        return t ? chrome.tabs.sendMessage(t.id!, { type: "tab:state" }) : null;
      });
      const dom = await page.evaluate(() => ({
        imgs: document.querySelectorAll("img").length,
        mediaHidden: document.querySelectorAll('[data-clearscroll-media][data-clearscroll="blurred"]').length,
        textHidden: document.querySelectorAll('[data-clearscroll="blurred"]:not([data-clearscroll-media])').length,
        title: document.title.slice(0, 80),
      }));
      await page.screenshot({ path: path.join(OUT, `${p.name}${downloads ? "-downloads" : ""}.png`) });
      const r = { page: p.name, topic: p.topic, downloads, title: dom.title, imgElements: dom.imgs, analysed: tab?.images?.analyzed ?? null, hiddenByImage: dom.mediaHidden, hiddenByText: dom.textHidden, skipped: tab?.images?.skipped ?? null, vision: tab?.images?.vision?.state ?? null };
      console.log(JSON.stringify(r));
      results.push(r);
    } catch (err) {
      console.log(JSON.stringify({ page: p.name, error: String(err).slice(0, 200) }));
      results.push({ page: p.name, error: String(err).slice(0, 200) });
    }
    await page.close();
  }
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
fs.writeFileSync(path.join(OUT, `results${downloads ? "-downloads" : ""}-${browser}.json`), JSON.stringify(results, null, 2));
