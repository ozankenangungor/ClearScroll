/**
 * Image-filtering evaluation in real Chromium with the production code path:
 * the bundled vision worker (ONNX Runtime Web, WebAssembly CPU) decodes each
 * image with createImageBitmap, preprocesses it exactly as the extension does
 * and embeds it; topics are embedded by the same worker; decisions use
 * src/shared/vision.ts unchanged.
 *
 *   node scripts/evaluate-vision.ts --manifest <dir>/manifest.json --set dev --calibrate
 *   node scripts/evaluate-vision.ts --manifest <dir>/manifest.json --set val --out docs/evaluation/vision/val.json
 *
 * The labelled images are third-party photos (Wikimedia Commons, openly
 * licensed) kept outside the repository; docs/evaluation/vision/ publishes the
 * manifest (titles, licences, sha256) and the aggregate results only.
 * --calibrate prints thresholds chosen on the given set; it must only ever be
 * run on the development set.
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

import { decideImage, isVisualMatch, meanVector, prepareVisionTopic, topicPrompts, visionScores, VISION_BACKGROUND_PROMPTS, VISION_RULES, type PreparedVisionTopic, type VisionRule } from "../src/shared/vision.ts";
import { FILTER_MODES, type FilterMode } from "../src/shared/settings.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const arg = (k: string, d?: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1]! : d);
const manifestPath = path.resolve(arg("--manifest") ?? fail("--manifest required"));
const set = arg("--set", "dev")!;
const outPath = arg("--out");
const calibrate = process.argv.includes("--calibrate");
/** Reuse embeddings from an earlier run (private; never committed). */
const cachePath = arg("--cache");
const MODEL_DIR = path.join(REPO, "build/vision/siglip-base-p16-224-int8");

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Topic → labels that count as positive. Every other non-ambiguous image is a negative. */
export const EVAL_TOPICS: Record<string, { positive: string[]; neighbours: string[] }> = {
  cats: { positive: ["cat"], neighbours: ["dog", "animal"] },
  dogs: { positive: ["dog"], neighbours: ["cat", "animal"] },
  football: { positive: ["football"], neighbours: ["rugby", "basketball"] },
  rugby: { positive: ["rugby"], neighbours: ["football", "basketball"] },
  basketball: { positive: ["basketball"], neighbours: ["football", "rugby"] },
  cryptocurrency: { positive: ["crypto"], neighbours: ["gold", "stocks"] },
  cars: { positive: ["car"], neighbours: ["airplane"] },
  airplanes: { positive: ["airplane"], neighbours: ["car"] },
  politics: { positive: ["protest"], neighbours: ["portrait"] },
  "fast food": { positive: ["food"], neighbours: ["objects"] },
};

interface Item {
  id: string;
  file: string;
  label: string;
  ambiguous: boolean;
  set: string;
}

const items = (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Item[]).filter((m) => m.set === set);
if (!items.length) fail(`no items for set ${set}`);
const imageRoot = path.dirname(manifestPath);

// ── Embed in Chromium with the production worker ─────────────────────────
const worker = (await esbuild.build({ entryPoints: [path.join(REPO, "src/vision/vision.worker.ts")], bundle: true, write: false, format: "esm", target: "chrome116" })).outputFiles[0]!.text;
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url!, "http://x").pathname);
  if (u === "/") return void res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>vision eval</title>");
  if (u === "/worker.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(worker);
  const file = u.startsWith("/ort/")
    ? path.join(REPO, "node_modules/onnxruntime-web/dist", path.basename(u))
    : u.startsWith("/model/")
      ? path.join(MODEL_DIR, u.slice(7))
      : u.startsWith("/img/")
        ? path.join(imageRoot, u.slice(5))
        : null;
  if (!file || !fs.existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" }).end(fs.readFileSync(file));
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + "/");
const prompts = [...new Set([...Object.keys(EVAL_TOPICS).flatMap(topicPrompts), ...VISION_BACKGROUND_PROMPTS])];
const cached = cachePath && fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : null;
const usable = cached && prompts.every((p) => cached.text[p]) && items.every((m) => cached.images[m.file]);
const result = usable ? cached : await page.evaluate(
  async ({ files, prompts }) => {
    const w = new Worker("/worker.js", { type: "module" });
    let next = 1;
    const call = (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
      new Promise<any>((resolve) => {
        const id = next++;
        const onMsg = (e: MessageEvent) => {
          if (e.data.id === id || (msg.type === "init" && !("id" in e.data))) {
            w.removeEventListener("message", onMsg);
            resolve(e.data);
          }
        };
        w.addEventListener("message", onMsg);
        w.postMessage({ ...msg, id }, transfer);
      });
    const init = await call({ type: "init", ortWasmUrl: "/ort/ort-wasm-simd-threaded.wasm", visionModelUrl: "/model/onnx/vision_model_quantized.onnx", textModelUrl: "/model/onnx/text_model_quantized.onnx", tokenizerUrl: "/model/tokenizer.json" });
    if (init.type !== "ready") throw new Error(init.error);
    const text: Record<string, number[]> = {};
    for (let i = 0; i < prompts.length; i += 16) {
      const batch = prompts.slice(i, i + 16);
      const r = await call({ type: "text", prompts: batch });
      if (r.type !== "text-done") throw new Error(r.error);
      const dim = r.vectors.length / batch.length;
      batch.forEach((p: string, k: number) => (text[p] = Array.from(r.vectors.subarray(k * dim, (k + 1) * dim))));
    }
    const images: Record<string, number[] | string> = {};
    const ms: number[] = [];
    for (const f of files) {
      const blob = await (await fetch("/img/" + f)).blob();
      const r = await call({ type: "image", blob, maxPixels: 24_000_000 });
      if (r.type === "image-done") {
        images[f] = Array.from(r.vector);
        ms.push(r.ms);
      } else images[f] = `${r.reason}: ${r.error}`;
    }
    w.terminate();
    return { loadMs: init.loadMs, text, images, ms };
  },
  { files: items.map((m) => m.file), prompts }
);
await browser.close();
srv.close();
if (cachePath && !usable) fs.writeFileSync(cachePath, JSON.stringify(result));

// ── Score ─────────────────────────────────────────────────────────────────
const vec = (v: number[]) => Float32Array.from(v);
const background = VISION_BACKGROUND_PROMPTS.map((p) => vec(result.text[p]!));
const topics = new Map<string, PreparedVisionTopic>();
for (const t of Object.keys(EVAL_TOPICS)) {
  const ps = topicPrompts(t);
  const flat = new Float32Array(ps.flatMap((p) => result.text[p]!));
  topics.set(t, prepareVisionTopic(t, meanVector(flat, ps.length), background));
}
const failed = items.filter((m) => typeof result.images[m.file] === "string");
const embedded = items.filter((m) => typeof result.images[m.file] !== "string");

interface Pair {
  topic: string;
  item: Item;
  positive: boolean;
  similarity: number;
  margin: number;
}
const pairs: Pair[] = [];
for (const [topic, spec] of Object.entries(EVAL_TOPICS)) {
  for (const m of embedded) pairs.push({ topic, item: m, positive: spec.positive.includes(m.label), ...visionScores(vec(result.images[m.file] as number[]), topics.get(topic)!) });
}

const hits = (p: Pair, rule: VisionRule) => p.similarity >= rule.minSimilarity && p.margin >= rule.minMargin;

function metrics(ps: Pair[], rule: VisionRule) {
  const clear = ps.filter((p) => !p.item.ambiguous);
  const tp = clear.filter((p) => p.positive && hits(p, rule)).length;
  const fp = clear.filter((p) => !p.positive && hits(p, rule)).length;
  const P = clear.filter((p) => p.positive).length;
  const N = clear.length - P;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = P ? tp / P : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { tp, fp, fn: P - tp, positives: P, negatives: N, precision, recall, f1, fpr: N ? fp / N : null };
}

if (calibrate) {
  if (set !== "dev") fail("--calibrate is only allowed on the development set");
  // Grid over both conditions; report the best F-beta per FPR cap. Used to
  // choose VISION_RULES; the chosen values are then fixed in the source.
  const grid: VisionRule[] = [];
  for (let s = 0; s <= 0.08001; s += 0.01) for (let m = -0.03; m <= 0.02001; m += 0.005) grid.push({ minSimilarity: +s.toFixed(3), minMargin: +m.toFixed(3) });
  for (const [mode, beta, maxFpr] of [["precision", 0.5, 0.005], ["balanced", 0.5, 0.01], ["aggressive", 1, 0.02]] as const) {
    let best: { f: number; rule: VisionRule } = { f: -1, rule: grid[0]! };
    for (const rule of grid) {
      const m = metrics(pairs, rule);
      if (m.precision === null || m.recall === null || (m.fpr ?? 0) > maxFpr) continue;
      const b2 = beta * beta;
      const f = ((1 + b2) * m.precision * m.recall) / (b2 * m.precision + m.recall || 1);
      if (f > best.f) best = { f, rule };
    }
    console.log(`${mode}: best F${beta} ${best.f.toFixed(3)} with FPR ≤ ${maxFpr}:`, best.rule, metrics(pairs, best.rule));
  }
}

const report = {
  set,
  model: "siglip-base-p16-224-int8",
  images: items.length,
  decodeFailures: failed.map((m) => ({ id: m.id, error: result.images[m.file] })),
  ambiguousImages: items.filter((m) => m.ambiguous).length,
  latency: (() => {
    const s = [...result.ms].sort((a, b) => a - b);
    return { modelLoadMs: result.loadMs, imageMedianMs: Math.round(s[s.length >> 1]!), imageP95Ms: Math.round(s[Math.floor(s.length * 0.95)]!), note: "1 WebAssembly thread, headless Chromium, decode + preprocess + inference" };
  })(),
  modes: Object.fromEntries(
    FILTER_MODES.map((mode: FilterMode) => {
      const thr = VISION_RULES[mode];
      const perTopic = Object.fromEntries(
        Object.entries(EVAL_TOPICS).map(([topic, spec]) => {
          const ps = pairs.filter((p) => p.topic === topic);
          const m = metrics(ps, thr);
          const neighbours = ps.filter((p) => !p.item.ambiguous && spec.neighbours.includes(p.item.label));
          const amb = ps.filter((p) => p.item.ambiguous && spec.positive.includes(p.item.label));
          const ambOther = ps.filter((p) => p.item.ambiguous && !spec.positive.includes(p.item.label));
          return [topic, { ...m, neighbourFalsePositives: `${neighbours.filter((p) => hits(p, thr)).length}/${neighbours.length}`, ambiguousSameClassHidden: `${amb.filter((p) => hits(p, thr)).length}/${amb.length}`, ambiguousOtherClassHidden: `${ambOther.filter((p) => hits(p, thr)).length}/${ambOther.length}`, falsePositives: ps.filter((p) => !p.item.ambiguous && !p.positive && hits(p, thr)).map((p) => p.item.id) }];
        })
      );
      // All ten topics active at once (as a user with many topics): any match hides the image.
      const clearItems = embedded.filter((m) => !m.ambiguous);
      const anyTopic = clearItems.filter((m) => decideImage(vec(result.images[m.file] as number[]), [...topics.values()], mode).matched);
      const covered = new Set(Object.values(EVAL_TOPICS).flatMap((t) => t.positive));
      const allTopics = { hidden: anyTopic.length, ofImages: clearItems.length, hiddenWithoutAnyTopicLabel: anyTopic.filter((m) => !covered.has(m.label)).map((m) => m.id), unrelatedImages: clearItems.filter((m) => !covered.has(m.label)).length };
      return [mode, { rule: thr, overall: metrics(pairs, thr), allTopicsActive: allTopics, perTopic }];
    })
  ),
};
// Sanity check: decideImage (used by the extension) agrees with the pairwise scores.
const sample = embedded[0]!;
const sv = vec(result.images[sample.file] as number[]);
const d = decideImage(sv, [...topics.values()], "balanced");
if (d.matched !== [...topics.values()].some((t) => isVisualMatch(visionScores(sv, t), "balanced"))) fail("decideImage disagrees with isVisualMatch");

for (const [mode, r] of Object.entries(report.modes)) {
  const o = r.overall;
  console.log(`\n[${set}] ${mode} (${JSON.stringify(r.rule)}): all topics active → ${r.allTopicsActive.hiddenWithoutAnyTopicLabel.length}/${r.allTopicsActive.unrelatedImages} unrelated images hidden; precision ${o.precision?.toFixed(3)} recall ${o.recall?.toFixed(3)} F1 ${o.f1?.toFixed(3)} FPR ${o.fpr?.toFixed(4)} (tp ${o.tp}, fp ${o.fp}, fn ${o.fn})`);
  for (const [t, m] of Object.entries(r.perTopic)) {
    console.log(`  ${t.padEnd(15)} P ${m.precision?.toFixed(2) ?? " — "} R ${m.recall?.toFixed(2)} FPR ${m.fpr?.toFixed(3)} neighbours ${m.neighbourFalsePositives} ambiguous(same) ${m.ambiguousSameClassHidden} ${m.falsePositives.length ? "fp: " + m.falsePositives.join(" ") : ""}`);
  }
}
console.log(`\nlatency: ${JSON.stringify(report.latency)}; decode failures: ${failed.length}`);
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
}
