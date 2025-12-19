/**
 * Decision logic: combines semantic similarity and lexical rules into a
 * per-text verdict. Pure and deterministic — the same function runs in the
 * extension (offscreen document) and in the evaluation harness
 * (scripts/evaluate.ts), so reported metrics describe shipped behaviour.
 */

import { compileLexicalRule, matchLexical, prepareLexicalText, type LexicalParams, type LexicalRule } from "./lexical.ts";
import type { FilterMode } from "./settings.ts";

export type MatchVia = "semantic" | "lexical";

export interface Decision {
  matched: boolean;
  topicId: string | null;
  /** Best cosine similarity against any topic (0 when semantic is off). */
  score: number;
  via: MatchVia | null;
}

export interface ModeParams {
  /** Cosine similarity at or above which a text matches a topic. */
  threshold: number;
  /** Texts shorter than this never match semantically (too little signal). */
  minSemanticChars: number;
  lexical: LexicalParams;
}

export interface PreparedTopic {
  id: string;
  text: string;
  lexical: LexicalRule;
  /** L2-normalised embedding, or null when semantic inference is off. */
  vector: Float32Array | null;
}

export const LEXICAL_PARAMS: Record<FilterMode, LexicalParams> = {
  precision: { minTokenLen: 6, minMultiTokenMatch: 2, multiTokenMatchRatio: 0.75 },
  balanced: { minTokenLen: 5, minMultiTokenMatch: 2, multiTokenMatchRatio: 0.6 },
  aggressive: { minTokenLen: 4, minMultiTokenMatch: 1, multiTokenMatchRatio: 0.5 },
};

export function prepareTopic(
  topic: { id: string; text: string },
  vector: Float32Array | null,
  params: ModeParams
): PreparedTopic {
  return { id: topic.id, text: topic.text, lexical: compileLexicalRule(topic.text, params.lexical), vector };
}

export function dot(a: Float32Array, aOffset: number, b: Float32Array, dim: number): number {
  let s = 0;
  for (let i = 0; i < dim; i++) s += a[aOffset + i]! * b[i]!;
  return s;
}

/**
 * @param textVectors flat row-major [texts.length × dim] embeddings, or null
 *                    for lexical-only operation.
 */
export function decide(
  texts: readonly string[],
  textVectors: Float32Array | null,
  dim: number,
  topics: readonly PreparedTopic[],
  params: ModeParams
): Decision[] {
  if (textVectors && textVectors.length !== texts.length * dim) {
    throw new Error(`expected ${texts.length * dim} embedding values, got ${textVectors.length}`);
  }
  return texts.map((text, i) => {
    let bestScore = 0;
    let bestTopic: PreparedTopic | null = null;
    if (textVectors) {
      bestScore = -Infinity;
      for (const t of topics) {
        if (!t.vector) continue;
        const s = dot(textVectors, i * dim, t.vector, dim);
        if (s > bestScore) {
          bestScore = s;
          bestTopic = t;
        }
      }
      if (!bestTopic) bestScore = 0;
    }

    if (bestTopic && bestScore >= params.threshold && text.trim().length >= params.minSemanticChars) {
      return { matched: true, topicId: bestTopic.id, score: bestScore, via: "semantic" };
    }

    const lex = prepareLexicalText(text);
    for (const t of topics) {
      if (matchLexical(t.lexical, lex)) {
        return { matched: true, topicId: t.id, score: bestScore, via: "lexical" };
      }
    }
    return { matched: false, topicId: null, score: bestScore, via: null };
  });
}
