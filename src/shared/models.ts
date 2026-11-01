/**
 * Model profiles: which encoder ships and its calibrated decision thresholds.
 *
 * Thresholds are model-specific — cosine similarity distributions differ
 * wildly between encoders — and were calibrated on the calibration split of
 * eval/dataset.jsonl by scripts/evaluate.ts (see docs/evaluation/RESULTS.md).
 */

import backgroundTopics from "./background-topics.json" with { type: "json" };
import type { FilterMode } from "./settings.ts";

export interface ModelProfile {
  id: string;
  /**
   * "margin": score = similarity − best unrelated background topic (thresholds
   * calibrated on that scale). "raw": plain cosine similarity, for encoders
   * whose similarities are too uniform for a background to be meaningful.
   */
  scoring: "margin" | "raw";
  thresholds: Record<FilterMode, number>;
  /**
   * Sibling veto ratio per mode (siblings.ts); absent: no veto. Calibrated on
   * the real-world dev split: per mode the smallest ratio in {1.2, 1.3, 1.4,
   * 1.5} whose recall loss is ≤ 2.5 points (docs/evaluation/realworld/).
   */
  siblingRatio?: Record<FilterMode, number>;
}

/**
 * Texts shorter than this never match semantically: short UI strings such as
 * "Markets · 4 min read" produce unreliable embeddings (that one scores 0.32
 * against "cryptocurrency" with MiniLM-L6). Lexical rules still apply to them.
 */
export const MIN_SEMANTIC_CHARS: Record<FilterMode, number> = {
  precision: 30,
  balanced: 24,
  aggressive: 16,
};

/**
 * Background topics for margin scoring (see `Background` in classifier.ts).
 * Fixed and generic: not derived from the evaluation topics. The last four
 * describe page furniture rather than subjects ("other" classes). Stored in
 * background-topics.json so tools/prepare_model.py can precompute them.
 */
export const BACKGROUND_TOPICS: readonly string[] = backgroundTopics.topics;

/** How a user's topic is phrased before embedding. "{topic}" = verbatim. */
export const TOPIC_TEMPLATE = "{topic}";

export function applyTopicTemplate(topic: string, template: string = TOPIC_TEMPLATE): string {
  // Replacer function: "$&", "$$" etc. in the user's topic must stay literal.
  return template.replace("{topic}", () => topic);
}

/**
 * Calibrated profiles. Thresholds apply to the *margin* score (similarity to
 * the topic minus the best unrelated background topic, classifier.ts), so
 * they can be small or negative. Values come from docs/evaluation/RESULTS.md
 * (English calibration split of eval/dataset.jsonl v2 incl. UI strings;
 * F0.5 / F1 / F2 maximisation for precision / balanced / aggressive). f16
 * and f32 weights calibrate to identical values.
 */
export const MODEL_PROFILES: Record<string, ModelProfile> = {
  "minilm-l6": {
    id: "minilm-l6",
    scoring: "margin",
    thresholds: { precision: 0.055, balanced: 0.005, aggressive: -0.04 },
    siblingRatio: { precision: 1.2, balanced: 1.3, aggressive: 1.4 },
  },
  "minilm-l3": {
    id: "minilm-l3",
    scoring: "margin",
    thresholds: { precision: 0.06, balanced: 0.01, aggressive: -0.03 },
  },
  "bert-tiny": {
    id: "bert-tiny",
    // bert-tiny's cosines are uniformly high (≈0.6–0.9 for any pair): every
    // background topic is "similar" to every query, so margins carry no
    // information. Scored by raw cosine; thresholds calibrated on that scale.
    scoring: "raw",
    thresholds: { precision: 0.76, balanced: 0.665, aggressive: 0.61 },
  },
};
