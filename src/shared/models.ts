/**
 * Model profiles: which encoder ships and its calibrated decision thresholds.
 *
 * Thresholds are model-specific — cosine similarity distributions differ
 * wildly between encoders — and were calibrated on the calibration split of
 * eval/dataset.jsonl by scripts/evaluate.ts (see docs/evaluation/RESULTS.md).
 */

import type { FilterMode } from "./settings.ts";

export interface ModelProfile {
  id: string;
  thresholds: Record<FilterMode, number>;
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

/** How a user's topic is phrased before embedding. "{topic}" = verbatim. */
export const TOPIC_TEMPLATE = "{topic}";

export function applyTopicTemplate(topic: string, template: string = TOPIC_TEMPLATE): string {
  // Replacer function: "$&", "$$" etc. in the user's topic must stay literal.
  return template.replace("{topic}", () => topic);
}

/**
 * Calibrated profiles. Values come from docs/evaluation/RESULTS.md
 * (English calibration split; F0.5 / F1 / F2 maximisation for
 * precision / balanced / aggressive).
 */
export const MODEL_PROFILES: Record<string, ModelProfile> = {
  "minilm-l6": {
    id: "minilm-l6",
    thresholds: { precision: 0.175, balanced: 0.135, aggressive: 0.115 },
  },
  "minilm-l3": {
    id: "minilm-l3",
    thresholds: { precision: 0.215, balanced: 0.19, aggressive: 0.15 },
  },
  "bert-tiny": {
    id: "bert-tiny",
    thresholds: { precision: 0.745, balanced: 0.665, aggressive: 0.61 },
  },
};
