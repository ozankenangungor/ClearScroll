/**
 * Reproducible performance benchmark of the built extension in Chromium.
 *
 *   node scripts/benchmark.ts [--dist dist] [--label cpu-headless] [--engine cpu|auto] [--headed] [--ignore-gpu-blocklist]
 *
 * Measures (all in the real extension, real model):
 *   - engine cold start (offscreen creation → first answer) and worker init
 *   - warm inference latency for batch sizes 1/8/24/64 (unique texts → no cache)
 *   - cache paths: re-classifying identical texts, switching topics
 *   - WebAssembly linear memory after load
 *   - page main-thread cost: long tasks (>50 ms) and total blocking time on a
 *     2,000-post page, filtering on vs off (A/B)
 * Writes docs/benchmarks/<label>.json and prints a Markdown summary.
 * Headless Chromium exposes only a software WebGPU adapter, so GPU numbers
 * require --headed on a machine with a real GPU and --engine auto (plus
 * --ignore-gpu-blocklist where Chrome blocklists the GPU for WebGPU, as on
 * the Linux machine used for docs/benchmarks).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type Worker } from "playwright";

const REPO = path.resolve(import.meta.dirname, "..");
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!.replace(/^--/, "");
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(a, next);
    i++;
  } else args.set(a, "1");
}
const DIST = path.resolve(REPO, args.get("dist") ?? "dist");
const engine = args.get("engine") ?? "cpu";
const label = args.get("label") ?? `${engine}-${args.has("headed") ? "headed" : "headless"}`;
const REPS = Number(args.get("reps") ?? 7);

const corpus = fs.readFileSync(path.join(REPO, "eval/dataset.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).text as string).filter((t) => /^[\x00-\x7F]*$/.test(t));
let uniq = 0;
const uniqueTexts = (n: number) => Array.from({ length: n }, () => `${corpus[uniq % corpus.length]} (${++uniq})`);

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { median: q(0.5), p95: q(0.95), min: s[0]!, n: s.length };
};

function bigPage(n: number): string {
  const posts = Array.from({ length: n }, (_, i) => `<article class="post"><p>${corpus[i % corpus.length]!.replace(/</g, "&lt;")}</p><span class="meta">post ${i}</span></article>`).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>.post{border-bottom:1px solid #ddd;padding:8px}</style>
<script>
  window.__lt = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: "longtask", buffered: true });
</script></head><body><main>${posts}</main></body></html>`;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(bigPage(2000));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "clearscroll-bench-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: !args.has("headed"),
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--enable-unsafe-webgpu",
    ...(args.has("ignore-gpu-blocklist") ? ["--ignore-gpu-blocklist"] : []),
  ],
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent("serviceworker");
const worker: Worker = sw;

const setSettings = (patch: Record<string, unknown>) =>
  worker.evaluate(
    (patch) => chrome.storage.local.set({ clearscroll_settings: { schema: 2, enabled: true, mode: "balanced", engine: "cpu", topics: [], excludedSites: [], protectedSelectors: [], ...patch } }),
    patch
  );

// ── Engine benchmarks (direct to the offscreen document) ──────────────────
await setSettings({ engine, topics: [{ id: "t", text: "cryptocurrency", enabled: true }] });
await new Promise((r) => setTimeout(r, 500));
await worker.evaluate(async () => {
  if ((await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })).length) await chrome.offscreen.closeDocument();
});

const classify = (texts: string[], topic = "cryptocurrency", generation = Date.now()) =>
  worker.evaluate(
    async ({ texts, topic, generation }) => {
      const t0 = performance.now();
      const r = await chrome.runtime.sendMessage({ type: "off:classify", target: "offscreen", frameKey: "bench", generation, mode: "balanced", topics: [{ id: "t", text: topic }], texts });
      return { ms: performance.now() - t0, ok: r.ok, engine: r.engine };
    },
    { texts, topic, generation }
  );

const cold = await worker.evaluate(async (engine) => {
  const t0 = performance.now();
  await chrome.offscreen.createDocument({ url: chrome.runtime.getURL(`offscreen/offscreen.html?backend=${engine}`), reasons: ["WORKERS" as chrome.offscreen.Reason], justification: "benchmark" });
  const created = performance.now() - t0;
  const r = await chrome.runtime.sendMessage({ type: "off:classify", target: "offscreen", frameKey: "bench", generation: 1, mode: "balanced", topics: [{ id: "t", text: "cryptocurrency" }], texts: ["Bitcoin climbs above $70,000 as ETF inflows accelerate."] });
  return { createDocumentMs: created, firstAnswerMs: performance.now() - t0, engine: r.engine };
}, engine);

const warm: Record<number, ReturnType<typeof stats> & { perTextMs: number }> = {};
for (const n of [1, 8, 24, 64]) {
  const xs: number[] = [];
  for (let i = 0; i < REPS; i++) xs.push((await classify(uniqueTexts(n))).ms);
  const s = stats(xs);
  warm[n] = { ...s, perTextMs: s.median / n };
}
// Realistic pages mix short headlines with long paragraphs (1–4 sentences).
const mixedRuns: number[] = [];
for (let i = 0; i < REPS; i++) {
  const texts = uniqueTexts(24).map((t, j) => Array.from({ length: (j % 4) + 1 }, () => t).join(" "));
  mixedRuns.push((await classify(texts)).ms);
}
const cachedTexts = uniqueTexts(24);
await classify(cachedTexts);
const cachedRuns: number[] = [];
for (let i = 0; i < REPS; i++) cachedRuns.push((await classify(cachedTexts)).ms);
const topicSwitch: number[] = [];
for (let i = 0; i < REPS; i++) topicSwitch.push((await classify(cachedTexts, `topic number ${i}`)).ms);
const engineStats = await worker.evaluate(() => chrome.runtime.sendMessage({ type: "off:stats", target: "offscreen" }));

// ── Page main-thread cost (A/B) ──────────────────────────────────────────
async function pageRun(filtering: boolean) {
  await worker.evaluate(async () => {
    if ((await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] })).length) await chrome.offscreen.closeDocument();
  });
  await setSettings({ engine, topics: filtering ? [{ id: "t", text: "cryptocurrency", enabled: true }] : [] });
  await new Promise((r) => setTimeout(r, 800));
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(base);
  // Sample the number of blurred items every 50 ms for 4 s: first blur and
  // the time the on-screen result stops changing.
  let firstBlurMs: number | null = null;
  let settledMs: number | null = null;
  let last = 0;
  while (Date.now() - t0 < 4000) {
    const n = await page.evaluate(() => document.querySelectorAll('[data-clearscroll="blurred"]').length);
    if (n > 0 && firstBlurMs === null) firstBlurMs = Date.now() - t0;
    if (n !== last) settledMs = Date.now() - t0;
    last = n;
    await page.waitForTimeout(50);
  }
  const tab = filtering
    ? await worker.evaluate(async (url) => {
        const [t] = await chrome.tabs.query({ url: url + "/*" });
        return chrome.tabs.sendMessage(t!.id!, { type: "tab:state" });
      }, base)
    : null;
  const r = await page.evaluate(() => {
    const lt = (window as unknown as { __lt: number[] }).__lt;
    return { longTasks: lt.length, totalBlockingMs: lt.reduce((s, d) => s + Math.max(0, d - 50), 0), maxTaskMs: Math.max(0, ...lt), blurred: document.querySelectorAll('[data-clearscroll="blurred"]').length };
  });
  await page.close();
  return { ...r, firstBlurMs, settledMs: filtering ? settledMs : null, analyzedAfter4s: tab?.analyzed ?? null };
}
const pageOff = await pageRun(false);
const pageOn = await pageRun(true);

const gpuAdapter = await worker.evaluate(async () => {
  // The engine's wgpu runtime requests a high-performance adapter.
  const a = await (navigator as any).gpu?.requestAdapter({ powerPreference: "high-performance" });
  return a ? `${a.info.vendor}/${a.info.architecture}${a.info.isFallbackAdapter ? " (software fallback)" : ""}` : "none";
});
const browserVersion = ctx.browser()?.version() ?? "unknown";
await ctx.close();
server.close();
fs.rmSync(profile, { recursive: true, force: true });

const size = (p: string) => fs.statSync(path.join(DIST, p)).size;
const model = JSON.parse(fs.readFileSync(path.join(DIST, "offscreen/model/model.json"), "utf8")).id as string;
const result = {
  label,
  date: new Date().toISOString(),
  environment: {
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    memGiB: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`,
    chromium: browserVersion,
    headless: !args.has("headed"),
    gpuAdapter,
    chromeFlags: args.has("ignore-gpu-blocklist") ? ["--ignore-gpu-blocklist"] : [],
    gitCommit: (() => {
      try {
        return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO }).toString().trim();
      } catch {
        return "unknown";
      }
    })(),
  },
  model,
  backend: cold.engine.backend,
  engineDetail: cold.engine.detail,
  sizesMiB: {
    wasm: size("offscreen/pkg/clearscroll_engine_bg.wasm") / 2 ** 20,
    weights: size("offscreen/model/weights.bin") / 2 ** 20,
  },
  cold: { createDocumentMs: cold.createDocumentMs, firstAnswerMs: cold.firstAnswerMs, workerInitMs: cold.engine.loadMs },
  warm,
  mixedLengthBatch24: stats(mixedRuns),
  cachedBatch24: stats(cachedRuns),
  topicSwitchBatch24: stats(topicSwitch),
  wasmMemoryMiB: engineStats.wasmMemoryBytes / 2 ** 20,
  engineStats,
  page2000Posts: { filteringOff: pageOff, filteringOn: pageOn },
};
fs.mkdirSync(path.join(REPO, "docs/benchmarks"), { recursive: true });
fs.writeFileSync(path.join(REPO, `docs/benchmarks/${label}.json`), JSON.stringify(result, null, 1) + "\n");

const f = (x: number) => x.toFixed(x < 10 ? 1 : 0);
console.log(`## ${label} — ${model} on ${result.backend} (${result.environment.cpu}; WebGPU adapter ${gpuAdapter}; Chromium ${browserVersion})\n`);
console.log(`| Metric | Value |\n|---|---|`);
console.log(`| Cold start (offscreen created → first answer) | ${f(cold.firstAnswerMs)} ms (worker init ${cold.engine.loadMs} ms) |`);
for (const [n, s] of Object.entries(warm)) console.log(`| Warm batch of ${n} (median / p95) | ${f(s.median)} / ${f(s.p95)} ms (${f(s.perTextMs)} ms per text) |`);
console.log(`| Warm batch of 24, mixed lengths (median / p95) | ${f(result.mixedLengthBatch24.median)} / ${f(result.mixedLengthBatch24.p95)} ms |`);
console.log(`| Same 24 texts again (cache) | ${f(result.cachedBatch24.median)} ms |`);
console.log(`| 24 cached texts, new topic | ${f(result.topicSwitchBatch24.median)} ms |`);
console.log(`| WASM linear memory | ${f(result.wasmMemoryMiB)} MiB |`);
console.log(`| 2,000-post page, filtering off: long tasks / TBT | ${pageOff.longTasks} / ${f(pageOff.totalBlockingMs)} ms |`);
console.log(`| 2,000-post page, filtering on: long tasks / TBT / max task | ${pageOn.longTasks} / ${f(pageOn.totalBlockingMs)} ms / ${f(pageOn.maxTaskMs)} ms |`);
console.log(`| 2,000-post page (cold engine): first blur / result settled after navigation | ${pageOn.firstBlurMs} / ${pageOn.settledMs} ms (${pageOn.analyzedAfter4s} units analysed, ${pageOn.blurred} blurred) |`);
