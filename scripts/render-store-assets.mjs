// Render existing vector branding into store assets; these are promotional
// graphics, not product screenshots. No extension/package files are changed.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const out = path.resolve(process.argv[2] ?? 'build/040-production-readiness/store-assets');
fs.mkdirSync(out, { recursive: true });
const svg = fs.readFileSync('assets/icons/icon.svg', 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 128, height: 128 });
  await page.setContent(`<body style="margin:0;background:transparent;padding:16px">${svg.replace('<svg ', '<svg width="96" height="96" ' )}</body>`);
  await page.screenshot({ path: path.join(out, 'store-icon-128.png'), omitBackground: true });
  await page.setViewportSize({ width: 440, height: 280 });
  await page.setContent(`<body style="margin:0;background:#f5f8fa;color:#203746;font:18px system-ui;padding:30px;box-sizing:border-box;width:440px;height:280px">
    <div style="display:flex;align-items:center;gap:14px">${svg.replace('<svg ', '<svg width="64" height="64" ')}<strong style="font-size:32px">ClearScroll</strong></div>
    <p style="font-size:26px;font-weight:600;margin:20px 0 12px">Choose what you see.</p><p style="margin:0">Best-effort topic blurring.<br>Local AI. Reveal or pause anytime.</p></body>`);
  await page.screenshot({ path: path.join(out, 'small-promo-440x280.png') });
} finally { await browser.close(); }
