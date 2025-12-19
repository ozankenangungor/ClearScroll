/**
 * Capture real screenshots of the built extension for the README.
 *   npm run build && node scripts/demo-screenshots.ts
 * Uses the deterministic fixture page tests/fixtures/pages/news.html.
 */
import path from "node:path";

import { getSettings, launchExtension, setSettings, waitAttr, waitRegistered } from "../tests/helpers/extension.ts";

const OUT = path.resolve(import.meta.dirname, "../docs/images");
const env = await launchExtension();
try {
  const page = await env.ctx.newPage();
  await page.setViewportSize({ width: 900, height: 760 });

  await page.goto(`${env.base}/news.html`);
  await page.screenshot({ path: `${OUT}/1-unfiltered.png` });

  const options = await env.ctx.newPage();
  // Tall viewport instead of fullPage: the sticky save bar would otherwise be
  // drawn over the last card in a stitched full-page capture.
  await options.setViewportSize({ width: 900, height: 1180 });
  await options.goto(`chrome-extension://${env.extId}/options/options.html`);
  for (const t of ["cryptocurrency", "football"]) {
    await options.fill("#new-topic", t);
    await options.click("#add-topic");
  }
  await options.locator('input[name="mode"][value="balanced"]').check();
  await options.fill("#excluded-sites", "mail.google.com");
  await options.click("#save");
  await options.waitForTimeout(1500); // let the status pill update
  await options.screenshot({ path: `${OUT}/2-options.png` });
  console.log("saved settings:", JSON.stringify((await getSettings(env)).topics.map((t: { text: string }) => t.text)));

  await waitRegistered(env, true);
  await page.bringToFront();
  await page.reload();
  await waitAttr(page, "#crypto-1 h2", "blurred");
  await waitAttr(page, "#sport-1-body", "blurred");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/3-filtered.png` });

  await page.click("#crypto-1 h2");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/4-revealed.png` });

  const popup = await env.ctx.newPage();
  await popup.setViewportSize({ width: 300, height: 330 });
  await popup.goto(`chrome-extension://${env.extId}/popup/popup.html`);
  await page.bringToFront();
  await popup.reload();
  await popup.waitForFunction(() => /hidden/.test(document.getElementById("site-state")?.textContent ?? ""));
  await popup.waitForTimeout(500);
  await popup.screenshot({ path: `${OUT}/5-popup.png` });

  await setSettings(env, { engine: "off" });
  await options.reload();
  await options.waitForTimeout(2500);
  await options.locator("#engine-status").screenshot({ path: `${OUT}/6-status-keyword-fallback.png` });
  console.log(`screenshots written to ${OUT}`);
} finally {
  await env.close();
}
