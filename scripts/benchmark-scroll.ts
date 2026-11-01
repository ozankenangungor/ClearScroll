/**
 * What a user sees while scrolling: how long matching pictures are on screen
 * *before* they are blurred.
 *
 *   node scripts/benchmark-scroll.ts [--dist dist] [--images <manifest.json>] [--label x] [--speed 1000]
 *
 * A feed of distinct photos from the development image set (cats among
 * other subjects, no captions) is scrolled at a constant speed (px/s) with
 * topic "cats" and image filtering on, after the model has loaded. For every
 * cat photo the page records when at least half of it entered the viewport
 * and when it was blurred: exposure = time on screen unblurred (0 if it was
 * blurred before it appeared). Needs the private photo set (default
 * ~/ClearScroll-private/vision/manifest.json).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DIST, launchContext } from "../tests/helpers/extension.ts";

const arg = (k: string, d?: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1]! : d);
const dist = path.resolve(arg("dist", DIST)!);
const manifestPath = arg("images", path.join(os.homedir(), "ClearScroll-private/vision/manifest.json"))!;
const speed = Number(arg("speed", "1000"));
const label = arg("label", "scroll")!;
const root = path.dirname(manifestPath);

interface Item { file: string; label: string; ambiguous: boolean; set: string }
const all = (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Item[]).filter((m) => m.set === "dev" && !m.ambiguous);
const cats = all.filter((m) => m.label === "cat");
const others = all.filter((m) => m.label !== "cat").slice(0, cats.length * 3);
// Deterministic interleaving: one cat, three others.
const feed: Item[] = [];
for (let i = 0; i < cats.length; i++) feed.push(cats[i]!, ...others.slice(i * 3, i * 3 + 3));

const page = `<!doctype html><meta charset="utf-8"><title>feed</title>
<style>body{margin:0;font:14px sans-serif} .p{width:420px;height:300px;margin:12px auto;display:block;object-fit:cover}</style>
<div style="height:900px"></div>
${feed.map((m, i) => `<img class="p" id="i${i}" data-cat="${m.label === "cat" ? 1 : 0}" src="/p/${i}">`).join("\n")}
<div style="height:1200px"></div>
<script>
  window.__log = {};
  const io = new IntersectionObserver((es) => { for (const e of es) { const r = (__log[e.target.id] ??= {}); if (e.isIntersecting && r.enter === undefined) r.enter = performance.now(); if (!e.isIntersecting && r.enter !== undefined && r.leave === undefined) r.leave = performance.now(); } }, { threshold: 0.5 });
  document.querySelectorAll("img.p").forEach((i) => io.observe(i));
  new MutationObserver((ms) => { for (const m of ms) { const el = m.target; if (el.getAttribute("data-clearscroll") === "blurred") { const r = (__log[el.id] ??= {}); r.blur ??= performance.now(); } } }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-clearscroll"] });
</script>`;

const srv = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/feed.html") return void res.writeHead(200, { "content-type": "text/html" }).end(page);
  if (u.pathname === "/warm.html") return void res.writeHead(200, { "content-type": "text/html" }).end(`<img src="/p/0" style="width:300px;height:220px">`);
  const m = feed[Number(u.pathname.slice(3))];
  if (!u.pathname.startsWith("/p/") || !m) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }).end(fs.readFileSync(path.join(root, m.file)));
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-scroll-"));
const { ctx, sw } = await launchContext(profile, { dist });
try {
  await sw.evaluate(() =>
    chrome.storage.local.set({ clearscroll_settings: { schema: 2, enabled: true, mode: "precision", engine: "cpu", topics: [{ id: "c", text: "cats", enabled: true }], excludedSites: [], protectedSelectors: [], images: true, imageDownloads: false } })
  );
  await new Promise((r) => setTimeout(r, 800));
  // Load the model first (a different page), so the run measures steady scrolling.
  const warm = await ctx.newPage();
  await warm.goto(`${base}/warm.html`);
  await warm.waitForTimeout(6000);
  await warm.close();

  const p = await ctx.newPage();
  await p.setViewportSize({ width: 1000, height: 900 });
  await p.goto(`${base}/feed.html?${label}`);
  await p.waitForTimeout(500);
  const total = await p.evaluate(() => document.body.scrollHeight - innerHeight);
  const stepMs = 50;
  for (let y = 0; y < total; y += (speed * stepMs) / 1000) {
    await p.evaluate((y) => scrollTo(0, y), y);
    await p.waitForTimeout(stepMs);
  }
  await p.waitForTimeout(3000);
  const log = (await p.evaluate(() => (window as any).__log)) as Record<string, { enter?: number; leave?: number; blur?: number }>;
  const catIds = feed.map((m, i) => (m.label === "cat" ? `i${i}` : null)).filter(Boolean) as string[];
  // At rest: which cat photos does the model recognise at all? (Misses there
  // are recall, not latency, and are excluded from the exposure figures.)
  const recognised = new Set<string>();
  for (const id of catIds) {
    await p.evaluate((id) => document.getElementById(id)!.scrollIntoView({ block: "center" }), id);
    for (let t = 0; t < 30 && !(await p.evaluate((id) => document.getElementById(id)!.getAttribute("data-clearscroll") === "blurred", id)); t++) await p.waitForTimeout(100);
    if (await p.evaluate((id) => document.getElementById(id)!.getAttribute("data-clearscroll") === "blurred", id)) recognised.add(id);
  }
  const exposures = catIds.filter((id) => recognised.has(id)).map((id) => {
    const r = log[id] ?? {};
    if (r.enter === undefined) return null;
    const end = r.blur ?? r.leave ?? Infinity;
    return Math.max(0, Math.min(end, r.leave ?? Infinity) - r.enter);
  }).filter((x): x is number => x !== null);
  const blurredBeforeVisible = catIds.filter((id) => log[id]?.blur !== undefined && log[id]!.enter !== undefined && log[id]!.blur! <= log[id]!.enter!).length;
  const neverBlurredWhileVisible = catIds.filter((id) => recognised.has(id) && log[id]?.enter !== undefined && (log[id]!.blur === undefined || (log[id]!.leave !== undefined && log[id]!.blur! > log[id]!.leave!))).length;
  const sorted = [...exposures].sort((a, b) => a - b);
  const wrong = feed.map((m, i) => (m.label !== "cat" && log[`i${i}`]?.blur !== undefined ? m.file : null)).filter(Boolean);
  const out = {
    label, dist: path.basename(dist), speedPxPerS: speed, catPhotos: catIds.length, feedPhotos: feed.length,
    recognisedAtRest: recognised.size, blurredBeforeVisible, recognisedButShownUnblurredThroughout: neverBlurredWhileVisible,
    exposureMs: { median: Math.round(sorted[sorted.length >> 1] ?? 0), p90: Math.round(sorted[Math.floor(sorted.length * 0.9)] ?? 0), mean: Math.round(exposures.reduce((a, b) => a + b, 0) / Math.max(1, exposures.length)) },
    otherPhotosBlurred: wrong.length,
  };
  console.log(JSON.stringify(out));
} finally {
  await ctx.close();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
