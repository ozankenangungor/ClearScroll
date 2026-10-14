// Launch Chromium with the built extension and serve fixture pages.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";

const REPO = path.resolve(import.meta.dirname, "../..");
export const DIST = process.env.CLEARSCROLL_DIST ?? path.join(REPO, "dist");
const PAGES = path.join(REPO, "tests/fixtures/pages");

export interface Env {
  ctx: BrowserContext;
  sw: Worker;
  extId: string;
  base: string;
  close(): Promise<void>;
}

export function startServer(): Promise<{ base: string; close(): Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // /csp/<page> serves the same page under a strict CSP like many large sites use.
    const strict = url.pathname.startsWith("/csp/");
    const file = path.join(PAGES, path.basename(url.pathname));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" };
    if (strict) headers["content-security-policy"] = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'none'";
    res.writeHead(200, headers).end(fs.readFileSync(file));
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(() => r())) });
    })
  );
}

export async function launchExtension(): Promise<Env> {
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) throw new Error(`${DIST} has no build; run npm run build`);
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-e2e-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--enable-unsafe-webgpu"],
  });
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  return {
    ctx,
    sw,
    extId,
    base: server.base,
    close: async () => {
      await ctx.close();
      await server.close();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

export async function setSettings(env: Env, patch: Record<string, unknown>): Promise<void> {
  await env.sw.evaluate(async (patch) => {
    const cur = (await chrome.storage.local.get("clearscroll_settings")).clearscroll_settings ?? {};
    await chrome.storage.local.set({
      clearscroll_settings: { schema: 2, enabled: true, mode: "balanced", engine: "cpu", topics: [], excludedSites: [], protectedSelectors: [], ...cur, ...patch },
    });
  }, patch);
}

export async function getSettings(env: Env): Promise<any> {
  return env.sw.evaluate(async () => (await chrome.storage.local.get("clearscroll_settings")).clearscroll_settings);
}

/** Wait until the background has (un)registered the content script. */
export async function waitRegistered(env: Env, registered: boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const n = await env.sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length);
    if ((n > 0) === registered) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`content script registered !== ${registered}`);
}

/** An extension page from which runtime messages can be sent. */
export async function extensionPage(env: Env, pathName = "options/options.html"): Promise<Page> {
  const page = await env.ctx.newPage();
  await page.goto(`chrome-extension://${env.extId}/${pathName}`);
  return page;
}

export async function uiStatus(env: Env): Promise<any> {
  const page = await extensionPage(env);
  const status = await page.evaluate(() => chrome.runtime.sendMessage({ type: "ui:status" }));
  await page.close();
  return status;
}

export const attr = (page: Page, sel: string) => page.locator(sel).getAttribute("data-clearscroll");

export async function waitAttr(page: Page, sel: string, value: string | null, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    ([sel, value]) => document.querySelector(sel)?.getAttribute("data-clearscroll") === value,
    [sel, value] as const,
    { timeout }
  );
}
