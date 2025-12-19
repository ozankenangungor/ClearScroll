/**
 * Privacy check: does ClearScroll cause any network traffic?
 *
 *   npm run build && node scripts/verify-no-egress.ts
 *
 * Runs the same browsing session twice — with and without the extension —
 * recording every request Chromium makes from any process (--log-net-log).
 * Remote host names are made unresolvable, so filtering must work offline.
 *
 * Fails if
 *   (a) any request is initiated by a chrome-extension:// origin, or
 *   (b) any external host is contacted only when the extension is loaded.
 * Chromium itself contacts Google services (component updater, account
 * check, autofill); those appear in both runs with a browser initiator and
 * are reported, not attributed to the extension.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { DIST, startServer } from "../tests/helpers/extension.ts";

interface NetEvent {
  type: number;
  params?: { url?: string; initiator?: string };
}

async function session(withExtension: boolean) {
  const netlog = path.join(os.tmpdir(), `clearscroll-netlog-${process.pid}-${withExtension}.json`);
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-egress-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [
      ...(withExtension ? [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] : []),
      `--log-net-log=${netlog}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  });
  let blurred = 0;
  try {
    if (withExtension) {
      let [sw] = ctx.serviceWorkers();
      sw ??= await ctx.waitForEvent("serviceworker");
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
      if (withExtension) await page.waitForSelector('[data-clearscroll="blurred"]', { timeout: 30_000 });
      await page.waitForTimeout(1500);
      blurred += await page.locator('[data-clearscroll="blurred"]').count();
    }
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
  const fromExtension: string[] = [];
  for (const e of log.events) {
    if (e.type !== START || !e.params?.url) continue;
    const u = new URL(e.params.url);
    if (e.params.initiator?.startsWith("chrome-extension://")) fromExtension.push(e.params.url);
    if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "127.0.0.1") external.add(u.hostname);
  }
  return { external, fromExtension, blurred };
}

const without = await session(false);
const withExt = await session(true);
const onlyWithExtension = [...withExt.external].filter((h) => !without.external.has(h));

console.log(`hosts contacted by Chromium itself (both runs): ${[...without.external].sort().join(", ") || "none"}`);
console.log(`hosts contacted only with ClearScroll loaded: ${onlyWithExtension.join(", ") || "none"}`);
console.log(`requests initiated by the extension origin: ${withExt.fromExtension.length}`);
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
  console.error("✖ external hosts contacted only when the extension is loaded");
  failed = true;
}
if (failed) process.exit(1);
console.log("✔ ClearScroll caused no network requests; filtering worked offline");
