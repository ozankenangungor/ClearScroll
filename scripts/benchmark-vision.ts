/**
 * Image-filtering benchmark of the built extension (real model, CPU backend).
 *
 *   node scripts/benchmark-vision.ts [--browser chromium|chrome] [--label x] [--images <manifest.json>] [--n 40]
 *
 * Measures in the real extension:
 *   - cold start: settings saved → first picture hidden (offscreen document,
 *     worker, model load, prompt embeddings, first inference), and the
 *     worker's own model load time;
 *   - per-picture cost on a gallery of distinct photos (no cache hits):
 *     worker inference time (median/p95) and wall time until all are analysed;
 *   - repeat visit: the same gallery again (image-embedding cache);
 *   - restart: images off and on again (as after a pause or browser restart)
 *     — time to the first hidden picture and peak memory;
 *   - memory: proportional set size (PSS) of all browser processes, before
 *     image filtering, peak (sampled every 250 ms) and steady (Linux only);
 *   - impact on text filtering: time until every on-screen paragraph of a long
 *     page is analysed, alone vs while the gallery is being analysed.
 * Writes docs/benchmarks/vision-<label>.json and prints a summary.
 *
 * Gallery photos: --images <manifest.json> (the private evaluation set; its
 * dev images) when available, else the ten test fixtures.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Page, Worker } from "playwright";

import { DIST, launchContext, startServer } from "../tests/helpers/extension.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const arg = (k: string, d?: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1]! : d);
const browser = (arg("browser", "chromium") as "chromium" | "chrome");
const label = arg("label", `cpu-${browser}`)!;
const N = Number(arg("n", "40"));
const manifestPath = arg("images", path.join(os.homedir(), "ClearScroll-private/vision/manifest.json"))!;

interface Photo { file: string; abs: string }
let photos: Photo[];
let gallerySource: string;
if (fs.existsSync(manifestPath)) {
  const root = path.dirname(manifestPath);
  photos = (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { file: string; set: string }[]).filter((m) => m.set === "dev").slice(0, N).map((m) => ({ file: m.file, abs: path.join(root, m.file) }));
  gallerySource = `${photos.length} distinct photos from the development image set`;
} else {
  const dir = path.join(REPO, "tests/fixtures/images");
  photos = fs.readdirSync(dir).filter((f) => /\.(jpg|webp)$/.test(f)).map((f) => ({ file: f, abs: path.join(dir, f) }));
  gallerySource = `${photos.length} test fixture photos`;
}

// Gallery server: every photo once, 4 per row, 240×180 px, no text.
const gallery = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/gallery.html") {
    const imgs = photos.map((_, i) => `<img src="/p/${i}" style="width:240px;height:180px;object-fit:cover">`).join("");
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>gallery</title><body style="margin:0;display:flex;flex-wrap:wrap;gap:4px">${imgs}</body>`);
    return;
  }
  const i = Number(url.pathname.slice(3));
  const p = photos[i];
  if (!url.pathname.startsWith("/p/") || !p) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": p.file.endsWith(".webp") ? "image/webp" : p.file.endsWith(".png") ? "image/png" : "image/jpeg", "cache-control": "no-store" }).end(fs.readFileSync(p.abs));
});
await new Promise<void>((r) => gallery.listen(0, "127.0.0.1", r));
const galleryBase = `http://127.0.0.1:${(gallery.address() as { port: number }).port}`;
const server = await startServer();

function pss(profile: string): number | null {
  if (process.platform !== "linux") return null;
  let total = 0;
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cmd.includes(profile)) continue;
      const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+) kB/m);
      if (m) total += Number(m[1]) * 1024;
    } catch {
      /* process exited */
    }
  }
  return total;
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-bench-vision-"));
const { ctx, sw } = await launchContext(profile, { browser, dist: DIST });
const extId = new URL(sw.url()).host;

async function set(sw: Worker, patch: Record<string, unknown>) {
  await sw.evaluate(async (patch) => {
    const cur = (await chrome.storage.local.get("clearscroll_settings")).clearscroll_settings ?? {};
    await chrome.storage.local.set({ clearscroll_settings: { schema: 2, enabled: true, mode: "precision", engine: "cpu", topics: [{ id: "c", text: "cats", enabled: true }], excludedSites: [], protectedSelectors: [], images: false, imageDownloads: false, ...cur, ...patch } });
  }, patch);
  await new Promise((r) => setTimeout(r, 500));
}

async function tabImages(page: Page): Promise<any> {
  return sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return (await chrome.tabs.sendMessage(tab!.id!, { type: "tab:state" })) as any;
  }, page.url());
}

async function waitAnalysed(page: Page, n: number, key: "images" | "text", timeout = 600_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const st = await tabImages(page).catch(() => null);
    const got = key === "images" ? st?.images?.analyzed ?? 0 : st?.analyzed ?? 0;
    if (got >= n) return Date.now() - t0;
    if (Date.now() - t0 > timeout) throw new Error(`${key}: ${got}/${n} analysed after ${timeout} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function visionStats(): Promise<any> {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/options/options.html`);
  const stats = await page.evaluate(() => chrome.runtime.sendMessage({ type: "off:vision-stats", target: "offscreen" }));
  const status = await page.evaluate(() => chrome.runtime.sendMessage({ type: "ui:status" }));
  await page.close();
  return { stats, status };
}

/** On-screen paragraphs of long.html analysed → elapsed ms. */
async function textRun(): Promise<number> {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1200, height: 900 });
  const t0 = Date.now();
  await page.goto(`${server.base}/long.html`);
  const expected = await page.evaluate(() => [...document.querySelectorAll("main p")].filter((p) => p.getBoundingClientRect().top <= 2.5 * innerHeight).length);
  await waitAnalysed(page, expected, "text");
  const ms = Date.now() - t0;
  await page.close();
  return ms;
}

const out: Record<string, unknown> = { label, browser, date: new Date().toISOString().slice(0, 10), cpu: os.cpus()[0]?.model, cores: os.cpus().length, gallery: gallerySource };
try {
  await set(sw, {});
  // Text baseline (warm text engine; images off).
  await textRun();
  const textAlone = [await textRun(), await textRun(), await textRun()].sort((a, b) => a - b)[1]!;
  const pssBefore = pss(profile);
  // Peak: sampled every 250 ms from here on (a single reading at the end of
  // the gallery depends on whether the short-lived text encoder has already
  // been released, i.e. on how fast the gallery was analysed).
  let pssPeak = pssBefore ?? 0;
  const sampler = setInterval(() => (pssPeak = Math.max(pssPeak, pss(profile) ?? 0)), 250);

  // Cold start: image filtering turned on, a page with one cat picture.
  await set(sw, { images: true });
  const fixture = await ctx.newPage();
  await fixture.setViewportSize({ width: 1000, height: 900 });
  const t0 = Date.now();
  await fixture.goto(`${server.base}/images.html`);
  await fixture.waitForSelector('#cat[data-clearscroll="blurred"]', { timeout: 300_000 });
  const coldFirstPictureMs = Date.now() - t0;
  const afterCold = await visionStats();
  await fixture.close();

  // Gallery of distinct photos (no cache hits), measured alongside a text page.
  const before = (await visionStats()).stats;
  const g = await ctx.newPage();
  await g.setViewportSize({ width: 1000, height: 4000 });
  const tg = Date.now();
  await g.goto(`${galleryBase}/gallery.html`);
  const textDuringImages = await textRun();
  await waitAnalysed(g, photos.length, "images");
  const galleryMs = Date.now() - tg;
  const after = await visionStats();
  const inferred = after.stats.inferred - before.inferred;
  const pssAfter = pss(profile);

  // Steady state: the text encoder is released after 20 s without new topics.
  await new Promise((r) => setTimeout(r, 25_000));
  const pssSteady = pss(profile);
  clearInterval(sampler);

  // Repeat visit: embeddings are cached.
  const g2 = await ctx.newPage();
  await g2.setViewportSize({ width: 1000, height: 4000 });
  const tr = Date.now();
  await g2.goto(`${galleryBase}/gallery.html?again`);
  await waitAnalysed(g2, photos.length, "images");
  const repeatMs = Date.now() - tr;
  for (const p of ctx.pages()) if (p.url().startsWith("http")) await p.close();

  // Restart: images off, then on again (as after a pause or a browser
  // restart): the image model reloads; a known topic's embedding may come
  // from the persistent store instead of the text encoder.
  await set(sw, { images: false });
  await new Promise((r) => setTimeout(r, 1500));
  const pssOff = pss(profile);
  await set(sw, { images: true });
  let restartPeak = pssOff ?? 0;
  const restartSampler = setInterval(() => (restartPeak = Math.max(restartPeak, pss(profile) ?? 0)), 250);
  const again = await ctx.newPage();
  await again.setViewportSize({ width: 1000, height: 900 });
  const ta = Date.now();
  await again.goto(`${server.base}/images.html?restart`);
  await again.waitForSelector('#cat[data-clearscroll="blurred"]', { timeout: 300_000 });
  const restartFirstPictureMs = Date.now() - ta;
  await new Promise((r) => setTimeout(r, 3000));
  clearInterval(restartSampler);

  Object.assign(out, {
    modelLoadMs: afterCold.status.vision.loadMs,
    imageModelThreads: afterCold.status.vision.threads ?? 1,
    coldFirstPictureMs,
    gallery: { photos: photos.length, inferred, wallMs: galleryMs, wallPerPictureMs: Math.round(galleryMs / photos.length), meanInferMs: Math.round((after.stats.inferMs - before.inferMs) / Math.max(1, inferred)) },
    repeatVisit: { wallMs: repeatMs, cacheHits: (await visionStats()).stats.cacheHits },
    restart: { firstPictureMs: restartFirstPictureMs, peakOverImagesOffMiB: pssOff === null ? null : +((restartPeak - pssOff) / 1048576).toFixed(0), textWorkerStarts: (await visionStats()).stats.textWorkerStarts, note: "images turned off and on again with the same topic; peak = 250 ms samples for 3 s after the first picture" },
    memory: pssBefore === null ? null : { pssBeforeImagesMiB: +(pssBefore / 1048576).toFixed(0), pssAfterGalleryMiB: +(pssAfter! / 1048576).toFixed(0), peakDeltaMiB: +((pssPeak - pssBefore) / 1048576).toFixed(0), steadyDeltaMiB: +((pssSteady! - pssBefore) / 1048576).toFixed(0), note: "sum of PSS over all browser processes of the profile; peak = maximum of 250 ms samples from turning images on until the steady reading; steady = 25 s after the last new topic (text encoder released)" },
    textFiltering: { aloneMs: textAlone, whileGalleryAnalysedMs: textDuringImages, note: "time until every paragraph within 2.5 viewports of long.html is analysed" },
    package: { distMiB: +(dirSize(DIST) / 1048576).toFixed(1) },
  });
} finally {
  await ctx.close();
  gallery.close();
  await server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

function dirSize(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? dirSize(path.join(dir, d.name)) : fs.statSync(path.join(dir, d.name)).size), 0);
}

const file = path.join(REPO, "docs/benchmarks", `vision-${label}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
console.log(`wrote ${path.relative(REPO, file)}`);
