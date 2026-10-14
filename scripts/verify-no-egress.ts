/**
 * Privacy check: does ClearScroll cause any network traffic?
 *
 *   npm run build && node scripts/verify-no-egress.ts [--browser chromium|chrome]
 *
 * Runs the same browsing session twice — once with ClearScroll and once with
 * a generated no-op control extension — recording every request the browser
 * makes from any process (--log-net-log). Remote host names are unresolvable,
 * so filtering must work fully offline.
 *
 * Both sessions load an extension and last exactly SESSION_MS: browsers make
 * timer-driven background requests (e.g. Chrome's GCM check-in ~5 s and
 * ~26 s after start) and requests tied to having any extension installed, so
 * a control without an extension or with a shorter session would wrongly
 * attribute them to ClearScroll (observed before this design).
 *
 * Fails if
 *   (a) any request is initiated by a chrome-extension:// origin, or
 *   (b) any external host is contacted only in the ClearScroll session.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DIST, launchContext, startServer } from "../tests/helpers/extension.ts";

const browser = (process.argv.includes("--browser") ? process.argv[process.argv.indexOf("--browser") + 1] : "chromium") as "chromium" | "chrome";
const SESSION_MS = 45_000;

interface NetEvent {
  type: number;
  params?: { url?: string; initiator?: string };
}

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
  const netlog = path.join(os.tmpdir(), `clearscroll-netlog-${process.pid}-${isClearScroll}.json`);
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-egress-"));
  const t0 = Date.now();
  const { ctx, sw } = await launchContext(profile, {
    dist,
    browser,
    extraArgs: [`--log-net-log=${netlog}`, "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
  });
  let blurred = 0;
  try {
    if (isClearScroll) {
      await sw.evaluate(() =>
        chrome.storage.local.set({
          clearscroll_settings: { schema: 2, enabled: true, mode: "balanced", engine: "auto", topics: [{ id: "t", text: "cryptocurrency", enabled: true }], excludedSites: [], protectedSelectors: [] },
        })
      );
      await new Promise((r) => setTimeout(r, 800));
    }
    const page = await ctx.newPage();
    for (const p of ["news.html", "feed.html", "csp/news.html"]) {
      await page.goto(`${server.base}/${p}`);
      if (isClearScroll) await page.waitForSelector('[data-clearscroll="blurred"]', { timeout: 30_000 });
      await page.waitForTimeout(1500);
      blurred += await page.locator('[data-clearscroll="blurred"]').count();
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
  fs.rmSync(netlog, { force: true });
  const log = JSON.parse(raw) as { constants: { logEventTypes: Record<string, number> }; events: NetEvent[] };
  const START = log.constants.logEventTypes.URL_REQUEST_START_JOB;
  const external = new Set<string>();
  const requests: { url: string; initiator: string }[] = [];
  const fromExtension: string[] = [];
  for (const e of log.events) {
    if (e.type !== START || !e.params?.url) continue;
    const u = new URL(e.params.url);
    if (e.params.initiator?.startsWith("chrome-extension://")) fromExtension.push(e.params.url);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "127.0.0.1") {
      external.add(u.hostname);
      requests.push({ url: e.params.url, initiator: e.params.initiator ?? "?" });
    }
  }
  return { external, requests, fromExtension, blurred };
}

const noop = noopExtension();
const control = await session(noop, false);
const withExt = await session(DIST, true);
fs.rmSync(noop, { recursive: true, force: true });
const onlyWithExtension = [...withExt.external].filter((h) => !control.external.has(h));

console.log(`browser: ${browser}; both sessions ${SESSION_MS / 1000} s with an extension loaded (control: no-op extension)`);
console.log(`hosts contacted by the browser itself (control session): ${[...control.external].sort().join(", ") || "none"}`);
console.log(`hosts contacted only in the ClearScroll session: ${onlyWithExtension.join(", ") || "none"}`);
console.log(`requests initiated by an extension origin: ${withExt.fromExtension.length}`);
console.log(`blurred items across 3 pages with remote DNS disabled: ${withExt.blurred}`);

let failed = false;
if (withExt.blurred === 0) {
  console.error("✖ filtering did not work offline");
  failed = true;
}
if (withExt.fromExtension.length) {
  console.error("✖ the extension made network requests:\n  " + withExt.fromExtension.join("\n  "));
  failed = true;
}
if (onlyWithExtension.length) {
  for (const r of withExt.requests.filter((r) => onlyWithExtension.includes(new URL(r.url).hostname))) {
    console.error(`  ${r.url.slice(0, 160)}  (initiator: ${r.initiator})`);
  }
  console.error("✖ external hosts contacted only in the ClearScroll session");
  failed = true;
}
if (failed) process.exit(1);
console.log("✔ ClearScroll caused no network requests; filtering worked offline");
