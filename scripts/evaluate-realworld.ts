/**
 * Real-world evaluation: text units captured from public web pages and
 * labelled by hand (methodology: eval/realworld/), scored with the
 * classifier exactly as the extension ships it — same decide(), same
 * background topics and thresholds.
 *
 *   node scripts/evaluate-realworld.ts [--splits test,dev] [--config shipped|previous] [--mode balanced]
 *                                      [--out docs/evaluation/realworld/RESULTS.md] [--json out.json]
 *                                      [--errors 10] [--calibrate docs/evaluation/realworld/calibration.json]
 *
 * The labelled texts are third-party page text and are not published: they
 * are read from $CLEARSCROLL_EVAL_DATA (default eval/private/realworld/,
 * gitignored) and must match the sha256 in eval/realworld/MANIFEST.json.
 * The written report holds aggregates only; --errors prints example errors
 * to the console.
 *
 * --config previous scores with the classifier as it was before the broad
 * background taxonomy (docs/evaluation/realworld/previous-classifier.json),
 * so before/after comparisons use the same frozen data.
 * --calibrate (dev split) picks one threshold per mode on the dev split
 * (F0.5 / F1 / F2, as scripts/evaluate.ts does) and writes the record that
 * tests/unit/profiles.test.ts checks the shipped thresholds against.
 *
 * Requires target/release/clearscroll-embed and the prepared model artifacts.
 * Metrics are over English texts with a definite label; label null =
 * ambiguous (counted separately).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BACKGROUND_SIMILARITY_CUTOFF, decide, LEXICAL_PARAMS, prepareTopic, type Background, type ModeParams } from "../src/shared/classifier.ts";
import { applyTopicTemplate, BACKGROUND_TOPICS, MIN_SEMANTIC_CHARS, MODEL_PROFILES, TOPIC_TEMPLATE } from "../src/shared/models.ts";
import { FILTER_MODES, type FilterMode } from "../src/shared/settings.ts";
import { DTYPE, MODEL, modelDir } from "./lib.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "target/release/clearscroll-embed");
const KNOWN = new Set(["splits", "config", "mode", "out", "json", "errors", "calibrate"]);
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]!.replace(/^--/, "");
  const value = process.argv[i + 1];
  if (!process.argv[i]!.startsWith("--") || !KNOWN.has(key) || value === undefined) {
    console.error(`evaluate-realworld.ts: bad argument ${process.argv[i]}; flags: ${[...KNOWN].map((k) => `--${k} <value>`).join(" ")}`);
    process.exit(2);
  }
  args.set(key, value);
}
const DATA = path.resolve(REPO, process.env.CLEARSCROLL_EVAL_DATA ?? "eval/private/realworld");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, "eval/realworld/MANIFEST.json"), "utf8"));
const splits = (args.get("splits") ?? "test,dev").split(",");
const mode = (args.get("mode") ?? "balanced") as FilterMode;
const configName = args.get("config") ?? "shipped";
const showErrors = Number(args.get("errors") ?? "0");

interface ClassifierConfig { background: string[]; cutoff: number; thresholds: Record<FilterMode, number> }
const profile = MODEL_PROFILES[MODEL];
if (!profile) throw new Error(`no profile for ${MODEL}`);
const configs: Record<string, ClassifierConfig> = {
  shipped: { background: [...BACKGROUND_TOPICS], cutoff: BACKGROUND_SIMILARITY_CUTOFF, thresholds: profile.thresholds },
  previous: (() => {
    const p = JSON.parse(fs.readFileSync(path.join(REPO, "docs/evaluation/realworld/previous-classifier.json"), "utf8"));
    return { background: p.background, cutoff: p.cutoff, thresholds: p.thresholds[MODEL] };
  })(),
};
const config = configs[configName];
if (!config) throw new Error(`--config must be one of ${Object.keys(configs).join(", ")}`);

interface Item { id: string; topic: string; label: 0 | 1 | null; lang: string; source: string; captured: string; text: string; card?: string }
type Row = Item & { score: number; lexical: boolean; predicted: boolean; via: string | null };

function loadSplit(split: string): Item[] {
  const file = path.join(DATA, `${split}.jsonl`);
  if (!fs.existsSync(file)) {
    console.error(`evaluate-realworld.ts: ${file} not found. The labelled texts are private; see eval/realworld/README.md.`);
    process.exit(2);
  }
  const sha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const want = MANIFEST.splits[split]?.sha256;
  if (sha !== want) {
    console.error(`evaluate-realworld.ts: ${file} has sha256 ${sha}, eval/realworld/MANIFEST.json lists ${want ?? "nothing"} — not the published data.`);
    process.exit(2);
  }
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function embed(texts: string[]): { dim: number; vectors: Float32Array[] } {
  const dir = modelDir(MODEL, DTYPE);
  const key = createHash("sha256").update(fs.readFileSync(path.join(dir, "weights.bin"))).update(JSON.stringify(texts)).digest("hex").slice(0, 16);
  const cache = path.join(REPO, "build/eval", `realworld-${MODEL}-${DTYPE}-${key}.json`);
  if (!fs.existsSync(cache)) {
    const stdout = execFileSync(CLI, ["--weights", path.join(dir, "weights.bin"), "--vocab", path.join(dir, "vocab.txt")], { input: JSON.stringify({ texts }), maxBuffer: 1 << 30 });
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, stdout);
  }
  const out = JSON.parse(fs.readFileSync(cache, "utf8")) as { dim: number; embeddings: number[][] };
  return { dim: out.dim, vectors: out.embeddings.map((e) => Float32Array.from(e)) };
}

function params(m: FilterMode, threshold: number): ModeParams {
  return { threshold, minSemanticChars: MIN_SEMANTIC_CHARS[m], lexical: LEXICAL_PARAMS[m] };
}

/** Score every item with decide() at threshold −Infinity → score and lexical verdict; thresholds are applied later. */
function score(items: Item[], m: FilterMode): Row[] {
  const topics = [...new Set(items.map((i) => i.topic))];
  const queries = topics.map((t) => applyTopicTemplate(t, TOPIC_TEMPLATE));
  const texts = [...new Set(items.map((i) => i.text))];
  const { dim, vectors } = embed([...queries, ...config!.background, ...texts]);
  const nb = config!.background.length;
  const background: Background | null = profile!.scoring === "margin"
    ? { vectors: Float32Array.from(vectors.slice(queries.length, queries.length + nb).flatMap((v) => [...v])), count: nb }
    : null;
  const tVec = new Map(texts.map((t, i) => [t, vectors[queries.length + nb + i]!]));
  const lexicalOnly = params(m, Infinity);
  const rows: Row[] = [];
  topics.forEach((topic, q) => {
    const prepared = [prepareTopic({ id: topic, text: topic }, vectors[q]!, lexicalOnly, background, config!.cutoff)];
    const its = items.filter((i) => i.topic === topic);
    const flat = new Float32Array(its.length * dim);
    its.forEach((it, i) => flat.set(tVec.get(it.text)!, i * dim));
    decide(its.map((i) => i.text), flat, dim, prepared, lexicalOnly, background).forEach((d, i) =>
      rows.push({ ...its[i]!, score: d.score, lexical: d.matched, predicted: false, via: null }));
  });
  return rows;
}

/** decide() semantics at a threshold: semantic if long enough and score ≥ t, else lexical. */
function apply(rows: Row[], m: FilterMode, t: number): Row[] {
  return rows.map((r) => {
    const semantic = r.text.trim().length >= MIN_SEMANTIC_CHARS[m] && r.score >= t;
    return { ...r, predicted: semantic || r.lexical, via: semantic ? "semantic" : r.lexical ? "lexical" : null };
  });
}

type Counts = { tp: number; fp: number; fn: number; tn: number };
function count(rows: { predicted: boolean; label: 0 | 1 | null }[]): Counts {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of rows) {
    if (r.label === null) continue;
    if (r.predicted && r.label) c.tp++;
    else if (r.predicted) c.fp++;
    else if (r.label) c.fn++;
    else c.tn++;
  }
  return c;
}
const rate = (a: number, b: number) => (b ? a / b : 0);
function summary(c: Counts) {
  const p = rate(c.tp, c.tp + c.fp), r = rate(c.tp, c.tp + c.fn);
  return { ...c, precision: p, recall: r, f1: p + r ? (2 * p * r) / (p + r) : 0, fpr: rate(c.fp, c.fp + c.tn) };
}
const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
const row = (name: string, s: ReturnType<typeof summary>) =>
  `| ${name} | ${s.tp + s.fp + s.fn + s.tn} | ${s.tp + s.fn} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)} | ${pct(s.fpr)} | ${s.tp} | ${s.fp} | ${s.fn} |`;
const HEAD = ["| Group | Texts | Positives | Precision | Recall | F1 | FPR | TP | FP | FN |", "|---|---|---|---|---|---|---|---|---|---|"];

/** Cards: hidden if any text is predicted; on topic if any text is labelled 1 (null if undecided). */
function cards(rows: Row[]) {
  const by = new Map<string, Row[]>();
  for (const r of rows) if (r.card) by.set(`${r.topic}|${r.source}|${r.card}`, [...(by.get(`${r.topic}|${r.source}|${r.card}`) ?? []), r]);
  return [...by.values()].map((rs) => ({
    predicted: rs.some((r) => r.predicted),
    label: rs.some((r) => r.label === 1) ? 1 : rs.some((r) => r.label === null) ? null : 0,
  })) as { predicted: boolean; label: 0 | 1 | null }[];
}

const lines: string[] = [];
const json: Record<string, unknown> = { model: MODEL, dtype: DTYPE, mode, config: configName, background: config.background.length, cutoff: config.cutoff, thresholds: config.thresholds };
lines.push("# Real-world evaluation", "");
lines.push(`Generated by \`node scripts/evaluate-realworld.ts\`. Do not edit by hand. Method and data: \`eval/realworld/\` (README.md, GUIDELINES.md, MANIFEST.json); the labelled texts themselves are private.`, "");
lines.push(`Classifier (\`--config ${configName}\`): ${MODEL} (${DTYPE} weights), ${config.background.length} background topics, paraphrase cutoff ${config.cutoff}, ${mode} threshold ${config.thresholds[mode]}; texts shorter than ${MIN_SEMANTIC_CHARS[mode]} characters match by keywords only. Metrics: English texts with a definite label, one topic per page.`, "");

if (args.has("calibrate")) {
  // Thresholds per mode on the dev split only.
  const dev = loadSplit("dev").filter((i) => i.lang === "en");
  const BETA: Record<FilterMode, number> = { precision: 0.5, balanced: 1, aggressive: 2 };
  const record: Record<string, unknown> = JSON.parse(fs.existsSync(args.get("calibrate")!) ? fs.readFileSync(args.get("calibrate")!, "utf8") : "{}");
  const thresholds = {} as Record<FilterMode, number>;
  for (const m of FILTER_MODES) {
    const base = score(dev, m);
    let best = { t: 0, f: -1 };
    for (let t = -0.5; t <= 1.0001; t += 0.005) {
      const s = summary(count(apply(base, m, t)));
      const b = BETA[m], f = s.precision + s.recall ? ((1 + b * b) * s.precision * s.recall) / (b * b * s.precision + s.recall) : 0;
      if (f > best.f + 1e-12) best = { t: Math.round(t * 1000) / 1000, f };
    }
    thresholds[m] = best.t;
  }
  record[MODEL] = { source: `eval/realworld dev split (sha256 ${MANIFEST.splits.dev.sha256.slice(0, 12)}), ${config.background.length} background topics, cutoff ${config.cutoff}, F0.5/F1/F2`, thresholds };
  fs.writeFileSync(args.get("calibrate")!, JSON.stringify(record, null, 2) + "\n");
  console.log(`calibrated ${MODEL}:`, JSON.stringify(thresholds));
  process.exit(0);
}

for (const split of splits) {
  const items = loadSplit(split);
  const rows = apply(score(items, mode), mode, config.thresholds[mode]);
  const en = rows.filter((r) => r.lang === "en");
  const topics = [...new Set(items.map((i) => i.topic))];
  const sources = [...new Set(items.map((i) => i.source))];
  lines.push(`## Split: ${split}`, "", `${items.length} texts (${en.filter((r) => r.label !== null).length} English with a definite label) from ${sources.length} pages, captured ${[...new Set(items.map((i) => i.captured))].join(", ")}.`, "");
  lines.push("**By topic**", "", ...HEAD);
  const splitJson: Record<string, unknown> = {};
  for (const topic of [...topics, "all"]) {
    const s = summary(count(en.filter((r) => topic === "all" || r.topic === topic)));
    lines.push(row(topic === "all" ? "**all**" : topic, s));
    splitJson[topic] = s;
  }
  const short = summary(count(en.filter((r) => r.text.trim().length < 40)));
  lines.push(row("texts < 40 characters", short), "");
  splitJson.short = short;
  if (en.some((r) => r.card)) {
    const cs = cards(en);
    const c = summary(count(cs));
    lines.push("**Cards** (what is hidden on screen: a text's card, or the text itself; a card is on topic if any of its texts is)", "", ...HEAD.map((h) => h.replace("| Texts |", "| Cards |")), row("all cards", c), "");
    splitJson.cards = c;
  }
  lines.push("**By page**", "", ...HEAD);
  for (const t of topics) for (const src of sources) {
    const rs = en.filter((r) => r.topic === t && r.source === src);
    if (rs.length) lines.push(row(`${t} · \`${src}\``, summary(count(rs))));
  }
  lines.push("");
  json[split] = { ...splitJson, rows: rows.map(({ id, predicted, score, via }) => ({ id, predicted, score, via })) };
  if (showErrors > 0) {
    for (const topic of topics) {
      const rs = en.filter((r) => r.topic === topic && r.label !== null);
      console.log(`\n${split} · ${topic}: false positives (highest score first)`);
      for (const r of rs.filter((r) => r.predicted && !r.label).sort((a, b) => b.score - a.score).slice(0, showErrors)) console.log(`  ${r.score.toFixed(3)} ${r.via} | ${r.text.slice(0, 110)}`);
      console.log(`${split} · ${topic}: false negatives (closest to the threshold first)`);
      for (const r of rs.filter((r) => !r.predicted && r.label).sort((a, b) => b.score - a.score).slice(0, showErrors)) console.log(`  ${r.score.toFixed(3)} ${r.text.length < MIN_SEMANTIC_CHARS[mode] ? "short" : ""} | ${r.text.slice(0, 110)}`);
    }
  }
}
console.log(lines.join("\n"));
if (args.has("out")) {
  fs.mkdirSync(path.dirname(path.resolve(args.get("out")!)), { recursive: true });
  fs.writeFileSync(args.get("out")!, lines.join("\n"));
}
if (args.has("json")) fs.writeFileSync(args.get("json")!, JSON.stringify(json, null, 1));
