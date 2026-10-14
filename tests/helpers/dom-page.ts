// Launch headless Chromium with the controller harness loaded into a page.
import * as esbuild from "esbuild";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const REPO = path.resolve(import.meta.dirname, "../..");
let bundle: string | null = null;

async function harnessBundle(): Promise<string> {
  bundle ??= (
    await esbuild.build({
      entryPoints: [path.join(REPO, "tests/dom/harness.ts")],
      bundle: true,
      write: false,
      format: "iife",
      target: "chrome116",
    })
  ).outputFiles[0]!.text;
  return bundle;
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

/** New page with `html` as body content and the harness installed. */
export async function harnessPage(browser: Browser, html: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on("pageerror", (e) => {
    throw e;
  });
  await page.setContent(`<!doctype html><html><head><style>
    [data-clearscroll="blurred"] { filter: blur(7px) !important; }
    .compact p { margin: 0; font-size: 8px; line-height: 10px; }
  </style></head><body>${html}</body></html>`);
  await page.addScriptTag({ content: await harnessBundle() });
  return page;
}

/** Wait until the controller has `n` pending classify requests. */
export async function waitPending(page: Page, n: number): Promise<void> {
  await page.waitForFunction((n) => (window as any).harness.pendingCount() >= n, n, { timeout: 5000 });
}

export const settle = (page: Page, ms = 120) => page.waitForTimeout(ms);
