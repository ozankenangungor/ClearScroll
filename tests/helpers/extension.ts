// Launch Chromium with the built extension and serve fixture pages.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";

const REPO = path.resolve(import.meta.dirname, "../..");
export const DIST = process.env.CLEARSCROLL_DIST ?? path.join(REPO, "dist");
const PAGES = path.join(REPO, "tests/fixtures/pages");
const IMAGES = path.join(REPO, "tests/fixtures/images");

/**
 * Test images under neutral URLs (/media/<key>): nothing in a URL, file name
 * or markup says what an image shows. Query strings make distinct URLs for
 * the same picture.
 */
export const MEDIA: Record<string, string> = {
  k1: "cat.jpg",
  k2: "dog.jpg",
  k3: "landscape.jpg",
  k4: "football.jpg",
  k5: "rugby.jpg",
  k6: "bitcoin.webp",
  k7: "gold.jpg",
  k8: "stock-exchange.jpg",
  k9: "burger.jpg",
  k10: "cat-2.jpg",
};

/** One request for a /media/ URL, as seen by the test server. */
export interface MediaRequest {
  host: string;
  path: string;
  cookie: string | null;
  referer: string | null;
  origin: string | null;
}

export interface Env {
  ctx: BrowserContext;
  sw: Worker;
  extId: string;
  base: string;
  port: number;
  mediaRequests: MediaRequest[];
  close(): Promise<void>;
}

export function startServer(): Promise<{ base: string; port: number; mediaRequests: MediaRequest[]; close(): Promise<void> }> {
  const mediaRequests: MediaRequest[] = [];
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/media/")) {
      mediaRequests.push({ host: req.headers.host ?? "", path: url.pathname + url.search, cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null, origin: req.headers.origin ?? null });
      const name = MEDIA[url.pathname.slice(7)];
      if (!name) {
        // Served as an image type, but not decodable.
        res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }).end("not an image");
        return;
      }
      const type = name.endsWith(".webp") ? "image/webp" : "image/jpeg";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(fs.readFileSync(path.join(IMAGES, name)));
      return;
    }
    if (url.pathname === "/set-cookie") {
      res.writeHead(200, { "content-type": "text/html", "set-cookie": "cs_session=secret; Path=/; SameSite=Lax" }).end("<!doctype html><title>cookie set</title>");
      return;
    }
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
      resolve({ base: `http://127.0.0.1:${port}`, port, mediaRequests, close: () => new Promise((r) => srv.close(() => r())) });
    })
  );
}

/**
 * Browser under test: Playwright's Chromium (default) or a branded Google
 * Chrome (`CLEARSCROLL_BROWSER=chrome`, binary from CHROME_PATH or
 * /usr/bin/google-chrome-stable). Branded Chrome ignores --load-extension
 * since version 137, so there the extension is loaded through the DevTools
 * protocol (Extensions.loadUnpacked, enabled by --enable-unsafe-extension-debugging).
 */
export interface LaunchOptions {
  dist?: string;
  browser?: "chromium" | "chrome";
  headless?: boolean;
  extraArgs?: string[];
}

/** Launch a persistent browser context with the extension loaded. */
export async function launchContext(profile: string, opts: LaunchOptions = {}): Promise<{ ctx: BrowserContext; sw: Worker }> {
  const dist = opts.dist ?? DIST;
  const browser = opts.browser ?? (process.env.CLEARSCROLL_BROWSER as LaunchOptions["browser"]) ?? "chromium";
  const headless = opts.headless ?? true;
  const extra = opts.extraArgs ?? [];
  if (browser === "chromium") {
    const ctx = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--enable-unsafe-webgpu", ...extra],
    });
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker");
    return { ctx, sw };
  }
  if (browser !== "chrome") throw new Error(`browser must be chromium or chrome, not ${browser}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable",
    headless,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", "--enable-unsafe-webgpu", ...extra],
  });
  const cdp = await ctx.browser()!.newBrowserCDPSession();
  const { id } = (await cdp.send("Extensions.loadUnpacked" as never, { path: dist } as never)) as { id: string };
  // Opening an extension page starts the service worker if it is not running yet.
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/options/options.html`);
  let sw: Worker | undefined;
  for (let i = 0; i < 100 && !sw; i++) {
    sw = ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${id}/`));
    if (!sw) await new Promise((r) => setTimeout(r, 100));
  }
  await page.close();
  if (!sw) throw new Error("extension service worker did not start in Chrome");
  return { ctx, sw };
}

export async function launchExtension(opts: LaunchOptions = {}): Promise<Env> {
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) throw new Error(`${DIST} has no build; run npm run build`);
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-e2e-"));
  const { ctx, sw } = await launchContext(profile, opts);
  const extId = new URL(sw.url()).host;
  return {
    ctx,
    sw,
    extId,
    base: server.base,
    port: server.port,
    mediaRequests: server.mediaRequests,
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
      // A complete settings object, as the options page writes it.
      clearscroll_settings: { schema: 2, enabled: true, mode: "balanced", engine: "cpu", topics: [], excludedSites: [], protectedSelectors: [], images: false, imageDownloads: false, ...cur, ...patch },
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
