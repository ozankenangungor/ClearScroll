/**
 * Semantic-quality evaluation of the shipped decision logic.
 *
 *   node scripts/evaluate.ts [--models bert-tiny,minilm-l6] [--out docs/evaluation] [--min-en-f1 0.6]
 *
 * Pipeline:
 *  1. Embed every dataset text and topic query with the production Rust
 *     encoder (target/release/clearscroll-embed, CPU backend; parity with
 *     WebGPU is checked separately in the browser smoke test).
 *  2. Split the dataset deterministically (FNV-1a hash of the item id) into a
 *     calibration half and a held-out test half.
 *  3. On the calibration half only, pick one threshold per mode by maximising
 *     F-beta (precision: β=0.5, balanced: β=1, aggressive: β=2) for the hybrid
 *     classifier, i.e. the exact `decide()` function the extension runs.
 *  4. Report lexical-only, semantic-only and hybrid metrics on the test half,
 *     overall and per language/category, plus the legacy 0.68/0.62/0.56
 *     thresholds for comparison.
 *
 * Evaluation unit: (topic query, text) pair. A user configuration is one
 * phrasing of one topic; a text is positive for it iff the text's labels
 * include that topic. Queries and texts are paired within the same language.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { decide, LEXICAL_PARAMS, prepareTopic, type ModeParams } from "../src/shared/classifier.ts";
import type { FilterMode } from "../src/shared/settings.ts";
import { MIN_SEMANTIC_CHARS, TOPIC_TEMPLATE, applyTopicTemplate } from "../src/shared/models.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "target/release/clearscroll-embed");

interface Item { id: string; lang: "en" | "tr"; kind: string; labels: string[]; text: string }
interface Query { topic: string; lang: "en" | "tr"; text: string }

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const models = (args.get("models") ?? "bert-tiny,minilm-l3,minilm-l6").split(",");
const outDir = path.resolve(REPO, args.get("out") ?? "docs/evaluation");
const MODES: FilterMode[] = ["precision", "balanced", "aggressive"];
const BETA: Record<FilterMode, number> = { precision: 0.5, balanced: 1, aggressive: 2 };
const template = args.get("template") ?? TOPIC_TEMPLATE;
/** Languages used for threshold calibration (the shipped encoders are English-only). */
const calibLangs = (args.get("calib-langs") ?? "en").split(",");
const LEGACY: Record<FilterMode, number> = { precision: 0.68, balanced: 0.62, aggressive: 0.56 };

const items: Item[] = fs.readFileSync(path.join(REPO, "eval/dataset.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const topicsDoc = JSON.parse(fs.readFileSync(path.join(REPO, "eval/topics.json"), "utf8"));
const queries: Query[] = [];
for (const [topic, byLang] of Object.entries<Record<string, string[]>>(topicsDoc.topics)) {
  for (const lang of ["en", "tr"] as const) for (const text of byLang[lang] ?? []) queries.push({ topic, lang, text });
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}
const split = (it: Item) => (fnv1a(it.id) % 2 === 0 ? "calib" : "test");

function embed(model: string, texts: string[]): { dim: number; vectors: Float32Array[]; ms: number; cached: boolean } {
  const dir = path.join(REPO, "build/models", model);
  const key = createHash("sha256").update(fs.readFileSync(path.join(dir, "weights.bin"))).update(JSON.stringify(texts)).digest("hex").slice(0, 16);
  const cache = path.join(REPO, "build/eval", `${model}-${key}.json`);
  let out: { dim: number; embeddings: number[][]; embed_ms: number };
  const cached = fs.existsSync(cache);
  if (cached) {
    out = JSON.parse(fs.readFileSync(cache, "utf8"));
  } else {
    const stdout = execFileSync(CLI, ["--weights", path.join(dir, "weights.bin"), "--vocab", path.join(dir, "vocab.txt")], {
      input: JSON.stringify({ texts }), maxBuffer: 1 << 30,
    });
    out = JSON.parse(stdout.toString());
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(out));
  }
  return { dim: out.dim, vectors: out.embeddings.map((e) => Float32Array.from(e)), ms: out.embed_ms, cached };
}

type Counts = { tp: number; fp: number; tn: number; fn: number };
const zero = (): Counts => ({ tp: 0, fp: 0, tn: 0, fn: 0 });
function add(c: Counts, predicted: boolean, actual: boolean) {
  if (predicted && actual) c.tp++; else if (predicted) c.fp++; else if (actual) c.fn++; else c.tn++;
}
function metrics(c: Counts) {
  const p = c.tp + c.fp ? c.tp / (c.tp + c.fp) : 0;
  const r = c.tp + c.fn ? c.tp / (c.tp + c.fn) : 0;
  const n = c.tp + c.fp + c.tn + c.fn;
  return {
    ...c,
    accuracy: n ? (c.tp + c.tn) / n : 0,
    precision: p,
    recall: r,
    f1: p + r ? (2 * p * r) / (p + r) : 0,
    fpr: c.fp + c.tn ? c.fp / (c.fp + c.tn) : 0,
    fnr: c.tp + c.fn ? c.fn / (c.tp + c.fn) : 0,
  };
}
const fbeta = (c: Counts, b: number) => {
  const m = metrics(c);
  return m.precision + m.recall ? ((1 + b * b) * m.precision * m.recall) / (b * b * m.precision + m.recall) : 0;
};

type System = "lexical" | "semantic" | "hybrid";
interface Pair { q: Query; it: Item; actual: boolean; score: number; lexical: boolean }

/** Pre-compute per-pair score and lexical verdict; thresholds are applied later. */
function buildPairs(subset: Item[], textVec: Map<string, Float32Array>, queryVec: Map<string, Float32Array>, dim: number, mode: FilterMode): Pair[] {
  const pairs: Pair[] = [];
  const params: ModeParams = { threshold: Infinity, minSemanticChars: MIN_SEMANTIC_CHARS[mode], lexical: LEXICAL_PARAMS[mode] };
  for (const q of queries) {
    const langItems = subset.filter((it) => it.lang === q.lang);
    const topic = prepareTopic({ id: q.topic, text: q.text }, queryVec.get(`${q.lang}|${q.text}`)!, params);
    const flat = new Float32Array(langItems.length * dim);
    langItems.forEach((it, i) => flat.set(textVec.get(it.id)!, i * dim));
    // threshold=Infinity → decide() reports pure lexical verdicts plus scores.
    const lex = decide(langItems.map((it) => it.text), flat, dim, [topic], params);
    langItems.forEach((it, i) => pairs.push({ q, it, actual: it.labels.includes(q.topic), score: lex[i]!.score, lexical: lex[i]!.matched }));
  }
  return pairs;
}

function predict(p: Pair, system: System, threshold: number, mode: FilterMode): boolean {
  const semantic = p.score >= threshold && p.it.text.trim().length >= MIN_SEMANTIC_CHARS[mode];
  if (system === "lexical") return p.lexical;
  if (system === "semantic") return semantic;
  return semantic || p.lexical;
}

function count(pairs: Pair[], system: System, threshold: number, mode: FilterMode, filter: (p: Pair) => boolean = () => true): Counts {
  const c = zero();
  for (const p of pairs) if (filter(p)) add(c, predict(p, system, threshold, mode), p.actual);
  return c;
}

function calibrate(pairs: Pair[], mode: FilterMode): number {
  let best = { t: 1, f: -1 };
  for (let t = 0.0; t <= 1.0001; t += 0.005) {
    const f = fbeta(count(pairs, "hybrid", t, mode), BETA[mode]);
    if (f > best.f + 1e-12) best = { t: Math.round(t * 1000) / 1000, f };
  }
  return best.t;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const report: string[] = [];
const results: Record<string, unknown> = {};
const calibItems = items.filter((it) => split(it) === "calib");
const testItems = items.filter((it) => split(it) === "test");

report.push("# Semantic filtering evaluation", "");
report.push(`Generated by \`node scripts/evaluate.ts\` on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.`, "");
report.push(`Dataset: ${items.length} texts (${items.filter((i) => i.lang === "en").length} English, ${items.filter((i) => i.lang === "tr").length} Turkish), `
  + `${queries.length} topic queries (${Object.keys(topicsDoc.topics).length} topics). Calibration split: ${calibItems.length} texts, test split: ${testItems.length} texts.`);
report.push(`Evaluation unit: (query, text) pairs within the same language. Topic template: \`${template}\`. Thresholds are calibrated on the calibration split of: ${calibLangs.join(", ")}.`, "");

for (const model of models) {
  const allTexts = items.map((it) => it.text);
  const qTexts = queries.map((q) => applyTopicTemplate(q.text, template));
  const { dim, vectors, ms, cached } = embed(model, [...allTexts, ...qTexts]);
  const textVec = new Map(items.map((it, i) => [it.id, vectors[i]!]));
  const queryVec = new Map(queries.map((q, i) => [`${q.lang}|${q.text}`, vectors[items.length + i]!]));

  const modelResult: Record<string, unknown> = { dim, cpuEmbedMsTotal: ms, texts: allTexts.length + qTexts.length };
  report.push(`## Model: \`${model}\``, "");
  report.push(`Native CPU embedding of ${allTexts.length + qTexts.length} texts took ${ms.toFixed(0)} ms (single thread, release build${cached ? "; measured when build/eval cache was created" : ""}). In-browser latency: docs/benchmarks.`, "");

  // Similarity separation (all pairs, both splits): how far apart are positives and negatives?
  const allPairs = buildPairs(items, textVec, queryVec, dim, "balanced");
  const pos = allPairs.filter((p) => p.actual).map((p) => p.score);
  const neg = allPairs.filter((p) => !p.actual).map((p) => p.score);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const rocAuc = (ps: Pair[]) => {
    const p = ps.filter((x) => x.actual).map((x) => x.score);
    const n = ps.filter((x) => !x.actual).map((x) => x.score);
    let a = 0;
    for (const x of p) for (const y of n) a += x > y ? 1 : x === y ? 0.5 : 0;
    return a / (p.length * n.length);
  };
  const auc = rocAuc(allPairs);
  const aucEn = rocAuc(allPairs.filter((p) => p.it.lang === "en"));
  const aucTr = rocAuc(allPairs.filter((p) => p.it.lang === "tr"));
  report.push(`Cosine similarity: mean ${mean(pos).toFixed(3)} for matching pairs vs ${mean(neg).toFixed(3)} for non-matching pairs. `
    + `ROC-AUC (threshold-free ranking quality): ${aucEn.toFixed(3)} English, ${aucTr.toFixed(3)} Turkish, ${auc.toFixed(3)} combined.`, "");
  modelResult.similarity = { meanPositive: mean(pos), meanNegative: mean(neg), auc, aucEn, aucTr };

  report.push("English test split (the supported language). Lexical = keyword rules only; semantic = embedding similarity only; hybrid = what the extension ships.", "");
  report.push("| Mode | Threshold (calibrated) | System | Precision | Recall | F1 | FPR | TP | FP | FN | TN |", "|---|---|---|---|---|---|---|---|---|---|---|");
  const modes: Record<string, unknown> = {};
  for (const mode of MODES) {
    const calib = buildPairs(calibItems, textVec, queryVec, dim, mode);
    const test = buildPairs(testItems, textVec, queryVec, dim, mode);
    const t = calibrate(calib.filter((p) => calibLangs.includes(p.it.lang)), mode);
    const rows: Record<string, unknown> = { threshold: t };
    const en = (p: Pair) => p.it.lang === "en";
    for (const system of ["lexical", "semantic", "hybrid"] as System[]) {
      rows[system] = metrics(count(test, system, t, mode));
      const m = metrics(count(test, system, t, mode, en));
      report.push(`| ${mode} | ${system === "lexical" ? "—" : t.toFixed(3)} | ${system} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${pct(m.fpr)} | ${m.tp} | ${m.fp} | ${m.fn} | ${m.tn} |`);
    }
    for (const system of ["lexical", "semantic", "hybrid"] as System[]) {
      const m = metrics(count(test, system, t, mode, (p) => p.it.lang === "en"));
      rows[`${system}_en`] = m;
    }
    const legacy = metrics(count(test, "hybrid", LEGACY[mode], mode, en));
    rows.legacyThreshold = { threshold: LEGACY[mode], ...legacy };
    report.push(`| ${mode} | ${LEGACY[mode]} (legacy) | hybrid | ${pct(legacy.precision)} | ${pct(legacy.recall)} | ${pct(legacy.f1)} | ${pct(legacy.fpr)} | ${legacy.tp} | ${legacy.fp} | ${legacy.fn} | ${legacy.tn} |`);

    const byLang: Record<string, unknown> = {};
    const byCat: Record<string, unknown> = {};
    for (const lang of ["en", "tr"]) byLang[lang] = metrics(count(test, "hybrid", t, mode, (p) => p.it.lang === lang));
    for (const topic of Object.keys(topicsDoc.topics)) byCat[topic] = metrics(count(test, "hybrid", t, mode, (p) => p.q.topic === topic));
    const hardNeg = count(test, "hybrid", t, mode, (p) => p.it.kind === "neg-hard");
    rows.byLanguage = byLang;
    rows.byTopic = byCat;
    rows.hardNegativeFpr = metrics(hardNeg).fpr;
    rows.errors = test
      .filter((p) => predict(p, "hybrid", t, mode) !== p.actual)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((p) => ({ query: p.q.text, text: p.it.text, actual: p.actual, score: Number(p.score.toFixed(3)), lexical: p.lexical }));
    modes[mode] = rows;
  }
  report.push("");

  const balanced = modes.balanced as any;
  report.push("Hybrid classifier, balanced mode, per language (test split):", "");
  report.push("| Language | Precision | Recall | F1 | FPR |", "|---|---|---|---|---|");
  for (const [lang, m] of Object.entries<any>(balanced.byLanguage)) report.push(`| ${lang} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${pct(m.fpr)} |`);
  report.push("", "Per topic (balanced, hybrid, test split, both languages):", "");
  report.push("| Topic | Precision | Recall | F1 | TP | FP | FN |", "|---|---|---|---|---|---|---|");
  for (const [topic, m] of Object.entries<any>(balanced.byTopic)) report.push(`| ${topic} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${m.tp} | ${m.fp} | ${m.fn} |`);
  report.push("", `False-positive rate on hard negatives (lexical traps), balanced: ${pct(balanced.hardNegativeFpr)}.`, "");
  report.push("<details><summary>Highest-scoring errors (balanced, hybrid)</summary>", "");
  report.push("| Query | Text | Label | Score | Lexical hit |", "|---|---|---|---|---|");
  for (const e of balanced.errors) report.push(`| ${e.query} | ${e.text.replace(/\|/g, "\\|")} | ${e.actual ? "positive" : "negative"} | ${e.score} | ${e.lexical ? "yes" : "no"} |`);
  report.push("", "</details>", "");
  modelResult.modes = modes;
  results[model] = modelResult;
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 1) + "\n");
fs.writeFileSync(path.join(outDir, "RESULTS.md"), report.join("\n") + "\n");
console.log(report.join("\n"));

// Optional regression gate for CI: --min-en-f1 0.6 fails if any evaluated
// model's English balanced-mode hybrid F1 (test split) drops below the value.
const minF1 = args.has("min-en-f1") ? Number(args.get("min-en-f1")) : null;
if (minF1 !== null) {
  for (const [model, r] of Object.entries<any>(results)) {
    const f1 = r.modes.balanced.hybrid_en.f1 as number;
    const verdict = f1 >= minF1 ? "ok" : "FAILED";
    console.error(`quality gate ${model}: English balanced F1 ${(f1 * 100).toFixed(1)}% (min ${(minF1 * 100).toFixed(1)}%) ${verdict}`);
    if (f1 < minF1) process.exitCode = 1;
  }
}
