/**
 * Real-world evaluation: text units captured from public web pages and
 * labelled by hand (eval/realworld/, see GUIDELINES.md), scored with the
 * classifier exactly as the extension ships it — same decide(), same
 * calibrated thresholds, nothing re-fitted to this data.
 *
 *   node scripts/evaluate-realworld.ts [--splits test,dev] [--mode balanced] [--template "{topic}"]
 *                                      [--errors 10] [--out docs/evaluation/realworld/RESULTS.md] [--json out.json]
 *
 * Requires target/release/clearscroll-embed (cargo build --release
 * --no-default-features --features cli) and the prepared model artifacts.
 * Metrics are over English texts with a definite label (label null =
 * ambiguous, counted separately). The dev split was used for error
 * analysis; the test split was labelled before it was ever evaluated and is
 * never used to choose a change.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { decide, LEXICAL_PARAMS, prepareTopic, type Background, type ModeParams } from "../src/shared/classifier.ts";
import { applyTopicTemplate, BACKGROUND_TOPICS, MIN_SEMANTIC_CHARS, MODEL_PROFILES, TOPIC_TEMPLATE } from "../src/shared/models.ts";
import type { FilterMode } from "../src/shared/settings.ts";
import { DTYPE, MODEL, modelDir } from "./lib.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "target/release/clearscroll-embed");
const KNOWN = new Set(["splits", "mode", "template", "errors", "out", "json"]);
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
const splits = (args.get("splits") ?? "test,dev").split(",");
const mode = (args.get("mode") ?? "balanced") as FilterMode;
const template = args.get("template") ?? TOPIC_TEMPLATE;
const showErrors = Number(args.get("errors") ?? "0");
const profile = MODEL_PROFILES[MODEL];
if (!profile) throw new Error(`no profile for ${MODEL}`);
const params: ModeParams = { threshold: profile.thresholds[mode], minSemanticChars: MIN_SEMANTIC_CHARS[mode], lexical: LEXICAL_PARAMS[mode] };

interface Item { id: string; topic: string; label: 0 | 1 | null; lang: string; source: string; captured: string; text: string }
type Row = Item & { predicted: boolean; score: number; via: string | null };

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

/** Score every item of a split with the shipped decide(). */
function score(items: Item[]): Row[] {
  const topics = [...new Set(items.map((i) => i.topic))];
  const queries = topics.map((t) => applyTopicTemplate(t, template));
  const texts = [...new Set(items.map((i) => i.text))];
  const { dim, vectors } = embed([...queries, ...BACKGROUND_TOPICS, ...texts]);
  const background: Background | null = profile!.scoring === "margin"
    ? { vectors: Float32Array.from(vectors.slice(queries.length, queries.length + BACKGROUND_TOPICS.length).flatMap((v) => [...v])), count: BACKGROUND_TOPICS.length }
    : null;
  const tVec = new Map(texts.map((t, i) => [t, vectors[queries.length + BACKGROUND_TOPICS.length + i]!]));
  const rows: Row[] = [];
  topics.forEach((topic, q) => {
    const prepared = [prepareTopic({ id: topic, text: topic }, vectors[q]!, params, background)];
    const its = items.filter((i) => i.topic === topic);
    const flat = new Float32Array(its.length * dim);
    its.forEach((it, i) => flat.set(tVec.get(it.text)!, i * dim));
    decide(its.map((i) => i.text), flat, dim, prepared, params, background).forEach((d, i) => rows.push({ ...its[i]!, predicted: d.matched, score: d.score, via: d.via }));
  });
  return rows;
}

const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
const lines: string[] = [];
const json: Record<string, unknown> = { model: MODEL, dtype: DTYPE, mode, template, threshold: params.threshold };
lines.push("# Real-world evaluation", "");
lines.push(`Generated by \`node scripts/evaluate-realworld.ts\`. Do not edit by hand. Data and labelling rules: \`eval/realworld/\` (GUIDELINES.md).`, "");
lines.push(`Classifier as shipped: ${MODEL} (${DTYPE} weights), ${mode} mode, threshold ${params.threshold} on the margin score, topic template \`${template}\`, texts shorter than ${params.minSemanticChars} characters matched by keywords only. Nothing was re-fitted to this data. Metrics: English texts with a definite label; one topic per page.`, "");
for (const split of splits) {
  const items: Item[] = fs.readFileSync(path.join(REPO, `eval/realworld/${split}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const rows = score(items);
  const topics = [...new Set(items.map((i) => i.topic))];
  const sources = [...new Set(items.map((i) => i.source))];
  lines.push(`## Split: ${split}`, "");
  lines.push(`${items.length} texts from ${sources.length} pages captured ${[...new Set(items.map((i) => i.captured))].join(", ")}: ${sources.map((s) => `\`${s}\``).join(", ")}.`, "");
  lines.push("| Topic | Texts | Positives | Precision | Recall | F1 | FPR | TP | FP | FN | Ambiguous texts hidden |", "|---|---|---|---|---|---|---|---|---|---|---|");
  const splitJson: Record<string, unknown> = {};
  for (const topic of [...topics, "all"]) {
    const rs = rows.filter((r) => r.lang === "en" && (topic === "all" || r.topic === topic));
    const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (const r of rs.filter((r) => r.label !== null)) {
      if (r.predicted && r.label) c.tp++;
      else if (r.predicted) c.fp++;
      else if (r.label) c.fn++;
      else c.tn++;
    }
    const p = c.tp / (c.tp + c.fp || 1), rec = c.tp / (c.tp + c.fn || 1), f1 = p + rec ? (2 * p * rec) / (p + rec) : 0, fpr = c.fp / (c.fp + c.tn || 1);
    const amb = rs.filter((r) => r.label === null);
    lines.push(`| ${topic} | ${c.tp + c.fp + c.fn + c.tn} | ${c.tp + c.fn} | ${pct(p)} | ${pct(rec)} | ${pct(f1)} | ${pct(fpr)} | ${c.tp} | ${c.fp} | ${c.fn} | ${amb.filter((r) => r.predicted).length}/${amb.length} |`);
    splitJson[topic] = { ...c, precision: p, recall: rec, f1, fpr };
  }
  lines.push("");
  if (showErrors > 0) {
    for (const topic of topics) {
      const rs = rows.filter((r) => r.lang === "en" && r.topic === topic && r.label !== null);
      const fps = rs.filter((r) => r.predicted && !r.label).sort((a, b) => b.score - a.score).slice(0, showErrors);
      const fns = rs.filter((r) => !r.predicted && r.label).sort((a, b) => b.score - a.score).slice(0, showErrors);
      lines.push(`<details><summary>${split} · ${topic}: highest-scoring false positives and false negatives</summary>`, "");
      lines.push("| Error | Score | Via | Text |", "|---|---|---|---|");
      for (const r of fps) lines.push(`| FP | ${r.score.toFixed(3)} | ${r.via} | ${r.text.slice(0, 110).replace(/\|/g, "/")} |`);
      for (const r of fns) lines.push(`| FN | ${r.score.toFixed(3)} | ${r.text.length < params.minSemanticChars ? "too short" : "below threshold"} | ${r.text.slice(0, 110).replace(/\|/g, "/")} |`);
      lines.push("", "</details>", "");
    }
  }
  json[split] = { ...splitJson, rows: rows.map(({ id, predicted, score, via }) => ({ id, predicted, score, via })) };
}
console.log(lines.join("\n"));
if (args.has("out")) {
  fs.mkdirSync(path.dirname(path.resolve(args.get("out")!)), { recursive: true });
  fs.writeFileSync(args.get("out")!, lines.join("\n"));
}
if (args.has("json")) fs.writeFileSync(args.get("json")!, JSON.stringify(json, null, 1));
