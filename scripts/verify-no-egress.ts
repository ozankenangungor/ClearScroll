/** Offline extension-egress gate. Raw NetLogs and browser/process metadata are retained.
 * Known browser activity reports require a complete measured caller fingerprint;
 * every other extension request and unexpected external differential still fails.
 * No Google-domain wildcard or blanket browser-traffic exemption exists.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { networkRequests, type NetLog } from "./privacy-attribution.ts";
import { DIST, launchContext, startServer } from "../tests/helpers/extension.ts";

const browser = (process.argv.includes("--browser") ? process.argv[process.argv.indexOf("--browser") + 1] : "chromium") as "chromium" | "chrome";
const images = process.argv.includes("--images");
const downloads = images && process.argv.includes("--downloads");
const feedback = process.argv.includes("--feedback");
// The image model's first load adds time; both sessions stay equally long.
const SESSION_MS = images ? 75_000 : 45_000;
/** Pictures served from a second, "other-domain" host (mapped to the test server). */
const REMOTE_HOST = "cdn.example";

const evidence = path.resolve(process.env.CS_PRIVACY_OUT ?? `build/privacy-${Date.now()}-${process.pid}`);
fs.mkdirSync(evidence, { recursive: true });
/** A minimal MV3 extension with a service worker and an options page. */
function noopExtension(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-noop-ext-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "noop control", version: "1", background: { service_worker: "sw.js" }, options_page: "options/options.html" }));
  fs.writeFileSync(path.join(dir, "sw.js"), "// no-op\n");
  fs.mkdirSync(path.join(dir, "options"));
  fs.writeFileSync(path.join(dir, "options/options.html"), "<!doctype html><title>noop</title>\n");
  return dir;
}

async function session(dist: string, isClearScroll: boolean) {
  const netlog = path.join(evidence, `${isClearScroll}-netlog.json`);
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-egress-"));
  const t0 = Date.now();
  const { ctx, sw } = await launchContext(profile, {
    dist,
    browser,
    extraArgs: [`--log-net-log=${netlog}`, "--enable-logging", `--log-file=${path.join(evidence, `${isClearScroll}-chrome.log`)}`, "--vmodule=update_client*=2,component_updater*=2", `--host-resolver-rules=MAP ${REMOTE_HOST} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
  });
  const cdp = await ctx.browser()!.newBrowserCDPSession();
  const metadata = { browser: await cdp.send("Browser.getVersion"), system: await cdp.send("SystemInfo.getInfo"), processes: await cdp.send("SystemInfo.getProcessInfo"), sessionMs: SESSION_MS };
  fs.writeFileSync(path.join(evidence, `${isClearScroll}-metadata.json`), JSON.stringify(metadata, null, 2));
  let blurred = 0;
  let blurredImages = 0;
  const pages = ["news.html", "feed.html", "csp/news.html"];
  if (images) pages.push(`images.html?remote=http://${REMOTE_HOST}:${server.port}`);
  try {
    if (isClearScroll) {
      await sw.evaluate(
        ({ images, downloads }) =>
          chrome.storage.local.set({
            clearscroll_settings: { schema: 2, enabled: true, mode: "balanced", engine: "auto", topics: [{ id: "t", text: "cryptocurrency", enabled: true }, { id: "c", text: "cats", enabled: true }], excludedSites: [], protectedSelectors: [], images, imageDownloads: downloads },
          }),
        { images, downloads }
      );
      await new Promise((r) => setTimeout(r, 800));
    }
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1000, height: 1400 });
    for (const [index, p] of pages.entries()) {
      // Identical navigation and activity schedule: Chrome activity reporting is
      // triggered by interactive sessions, including synthetic mouse/keyboard input.
      const due = t0 + 4000 + index * (images ? 13000 : 9000);
      if (Date.now() > due + 2000) throw Error("Missed matched navigation window");
      await page.waitForTimeout(Math.max(0, due - Date.now()));
      await page.goto(`${server.base}/${p}`);
      await page.mouse.click(950, 1300);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      if (isClearScroll) await page.waitForSelector('[data-clearscroll="blurred"]', { timeout: 30_000 });
      if (isClearScroll && p.startsWith("images.html")) {
        // The first picture waits for the image model to load.
        await page.waitForSelector('#cat[data-clearscroll="blurred"]', { timeout: 120_000 });
        if (downloads) await page.waitForSelector('#remote[data-clearscroll="blurred"]', { timeout: 60_000 });
      }
      await page.waitForTimeout(1500);
      blurred += await page.locator('[data-clearscroll="blurred"]').count();
      blurredImages += await page.locator('img[data-clearscroll="blurred"]').count();
    }
    if (isClearScroll && feedback) {
      const id = new URL(sw.url()).host;
      const popup = await ctx.newPage();
      await popup.goto(`chrome-extension://${id}/popup/popup.html`);
      const reply = await popup.evaluate(async url => {
        const tab = (await chrome.tabs.query({})).find(t => t.url === url)!;
        return chrome.tabs.sendMessage(tab.id!, { type: "tab:feedback" });
      }, page.url());
      if (!reply?.ok) throw Error("Feedback picker unavailable");
      await page.locator('[data-clearscroll="blurred"]').first().click();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space"); // Explicit diagnostic consent.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space"); // Explicit local save.
      await popup.waitForFunction(async () => ((await chrome.storage.local.get("clearscroll_feedback")).clearscroll_feedback as any[])?.length === 1);
      await page.keyboard.press("Escape");
      console.log("Feedback with optional diagnostics saved locally during offline privacy session.");
      await popup.close();
    }
    if (isClearScroll && process.argv.includes("--probe-egress")) {
      // Deliberate negative control in this isolated test profile. Must fail the gate,
      // even when trying to imitate the browser reporter's destination and headers.
      await sw.evaluate(() => fetch("https://update.googleapis.com/service/update2/json", {
        method: "POST", headers: { "X-Goog-Update-Updater": "activity_reporter-157.0.8103.38", "X-Goog-Update-AppId": "{cd7cc169-013a-4c79-94bc-cf5c8d78cccf}", "X-Goog-Update-Interactivity": "bg" }, body: "synthetic-test-only"
      }).catch(() => undefined));
    }
    const left = SESSION_MS - (Date.now() - t0);
    if (left < 0) throw new Error(`session exceeded ${SESSION_MS} ms; raise SESSION_MS so both runs are equally long`);
    await page.waitForTimeout(left);
  } finally {
    await ctx.close();
    await server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  let raw = fs.readFileSync(netlog, "utf8").trim();
  if (!raw.endsWith("}")) raw = raw.replace(/,\s*$/, "") + "]}";
  fs.writeFileSync(netlog, raw);
  const log = JSON.parse(raw) as NetLog;
  const all = networkRequests(log);
  const requests = all.filter(r => r.external);
  const browserOwned = requests.filter(r => r.activityReporter);
  const external = new Set(requests.filter(r => !r.activityReporter).map(r => new URL(r.url).hostname));
  const fromExtension = all.filter(r => r.extension).map(r => r.url);
  fs.writeFileSync(path.join(evidence, `${isClearScroll}-requests.json`), JSON.stringify(all, null, 2));
  const remoteMedia = server.mediaRequests.filter((r) => r.host.startsWith(REMOTE_HOST));
  return { external, requests, browserOwned, fromExtension, blurred, blurredImages, remoteMedia };
}

const noop = noopExtension();
const control = await session(noop, false);
const withExt = await session(DIST, true);
fs.rmSync(noop, { recursive: true, force: true });
const onlyWithExtension = [...withExt.external].filter((h) => !control.external.has(h));
// With downloads allowed, requests to the displayed other-domain pictures are
// the expected, documented behaviour; everything else from the extension is not.
const expectedDownloads = downloads ? ["/media/k1?poster", "/media/k1?remote"] : [];
const isExpectedDownload = (u: string) => {
  const url = new URL(u);
  return url.hostname === REMOTE_HOST && expectedDownloads.includes(url.pathname + url.search);
};
const extensionDownloads = withExt.fromExtension.filter(isExpectedDownload);
const unexpected = withExt.fromExtension.filter((u) => !isExpectedDownload(u));

console.log(`browser: ${browser}; mode: ${downloads ? "text + images + downloads" : images ? "text + images (downloads off)" : "text only (default settings)"}; both sessions ${SESSION_MS / 1000} s with an extension loaded (control: no-op extension)`);
console.log(`control external hosts (excluding attributed browser activity reports): ${[...control.external].sort().join(", ") || "none"}`);
console.log(`hosts contacted only in the ClearScroll session: ${onlyWithExtension.join(", ") || "none"}`);
console.log(`attributed Chrome activity reports: control ${control.browserOwned.length}; ClearScroll ${withExt.browserOwned.length}; raw evidence ${evidence}`);
console.log(`requests initiated by an extension origin: ${withExt.fromExtension.length}`);
console.log(`blurred items across ${images ? 4 : 3} pages with remote DNS disabled: ${withExt.blurred}${images ? ` (pictures: ${withExt.blurredImages})` : ""}`);
if (downloads) console.log(`expected picture downloads by the extension: ${extensionDownloads.length} (${extensionDownloads.map((u) => new URL(u).pathname + new URL(u).search).join(", ")})`);

let failed = false;
if (withExt.blurred === 0) {
  console.error("✖ filtering did not work offline");
  failed = true;
}
if (images && withExt.blurredImages === 0) {
  console.error("✖ image filtering did not hide any picture");
  failed = true;
}
if (unexpected.length) {
  console.error("✖ the extension made network requests:\n  " + unexpected.join("\n  "));
  failed = true;
}
if (downloads) {
  const extensionMedia = withExt.remoteMedia.filter((r) => r.referer === null);
  const seen = extensionMedia.map((r) => r.path).sort();
  if (JSON.stringify(seen) !== JSON.stringify(expectedDownloads)) {
    console.error(`✖ expected exactly one download of each displayed other-domain picture, got: ${seen.join(", ") || "none"}`);
    failed = true;
  }
  if (extensionMedia.some((r) => r.cookie !== null)) {
    console.error("✖ a picture download carried cookies");
    failed = true;
  }
}
if (onlyWithExtension.length) {
  for (const r of withExt.requests.filter((r) => onlyWithExtension.includes(new URL(r.url).hostname))) {
    console.error(`  ${r.url.slice(0, 160)}  (initiator: ${r.initiator})`);
  }
  console.error("✖ external hosts contacted only in the ClearScroll session");
  failed = true;
}
if (failed) process.exit(1);
console.log(downloads ? "✔ ClearScroll requested only the displayed other-domain pictures (once each, no cookies); filtering worked offline" : "✔ No unexpected extension network requests observed; filtering worked offline; browser-owned activity reported separately");
