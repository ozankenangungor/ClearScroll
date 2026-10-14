// Render assets/icons/icon.svg to the PNG sizes the manifest needs.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { REPO } from "./lib.mjs";

const svg = fs.readFileSync(path.join(REPO, "assets/icons/icon.svg"), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(REPO, `assets/icons/icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log("icons rendered");
