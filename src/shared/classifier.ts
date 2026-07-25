/**
 * Decision logic: combines semantic similarity and lexical rules into a
 * per-text verdict. Pure and deterministic — the same function runs in the
 * extension (offscreen document) and in the evaluation harness
 * (scripts/evaluate.ts), so reported metrics describe shipped behaviour.
 */

import { compileLexicalRule, matchLexical, prepareLexicalText, type LexicalParams, type LexicalRule } from "./lexical.ts";
import type { FilterMode } from "./settings.ts";
import { rivalled, type SiblingPlan } from "./siblings.ts";

export type MatchVia = "semantic" | "lexical";

export interface Decision {
  matched: boolean;
  topicId: string | null;
  /**
   * Decision score of the best topic (0 when semantic is off): cosine
   * similarity minus the text's best similarity to the background topics
   * that are not related to that topic (see `Background`).
   */
  score: number;
  /** Raw cosine similarity of the best topic (diagnostics). */
  similarity: number;
  via: MatchVia | null;
  /**
   * The best topic's sibling veto applies to this text: it is clearly closer
   * to a sibling subject than to the topic (siblings.ts), so it cannot match
   * semantically — set whether or not its score would have reached the
   * threshold. Keyword matches are never withheld.
   */
  rivalled: boolean;
}

/**
 * Background topics: generic subjects plus a few kinds of page furniture
 * (menus, comment bars, ads, article metadata). A text only matches a user
 * topic if it is more similar to that topic than to every unrelated background
 * topic. Generic UI strings ("Posted 3 hours ago · 12 comments") are mildly
 * similar to *every* short topic query; the margin removes that common offset
 * (measured: UI false positives 17.4% → 1.5%, see docs/MODEL.md).
 */
export interface Background {
  /** Flat row-major [count × dim] L2-normalised embeddings. */
  vectors: Float32Array;
  count: number;
}

/** Background topics at least this similar to the user's topic are ignored
 * for it (they are near-synonyms, e.g. "sports" for "football"). */
export const BACKGROUND_SIMILARITY_CUTOFF = 0.5;

export interface ModeParams {
  /** Decision score (margin, see Decision.score) at or above which a text matches. */
  threshold: number;
  /** Texts shorter than this never match semantically (too little signal). */
  minSemanticChars: number;
  lexical: LexicalParams;
  /**
   * Sibling veto (siblings.ts): a semantic match is withheld when the best
   * rival similarity exceeds this many times the topic side's. Absent or
   * Infinity: off.
   */
  siblingRatio?: number;
}

export interface PreparedTopic {
  id: string;
  text: string;
  lexical: LexicalRule;
  /** L2-normalised embedding, or null when semantic inference is off. */
  vector: Float32Array | null;
  /** Indices of background topics that compete with this topic. */
  background: number[];
  /** Sibling subjects that compete with this topic (null: none). */
  siblings: SiblingPlan | null;
}

export const LEXICAL_PARAMS: Record<FilterMode, LexicalParams> = {
  precision: { minTokenLen: 6, minMultiTokenMatch: 2, multiTokenMatchRatio: 0.75 },
  balanced: { minTokenLen: 5, minMultiTokenMatch: 2, multiTokenMatchRatio: 0.6 },
  aggressive: { minTokenLen: 4, minMultiTokenMatch: 1, multiTokenMatchRatio: 0.5 },
};

export function prepareTopic(
  topic: { id: string; text: string },
  vector: Float32Array | null,
  params: ModeParams,
  background: Background | null = null,
  cutoff: number = BACKGROUND_SIMILARITY_CUTOFF,
  siblings: SiblingPlan | null = null
): PreparedTopic {
  const competing: number[] = [];
  if (vector && background && background.count > 0) {
    const dim = vector.length;
    let leastSimilar = 0;
    let leastSim = Infinity;
    for (let k = 0; k < background.count; k++) {
      const sim = dot(background.vectors, k * dim, vector, dim);
      if (sim < cutoff) competing.push(k);
      if (sim < leastSim) {
        leastSim = sim;
        leastSimilar = k;
      }
    }
    // A very generic topic can be close to every background topic. It must
    // still be scored as a margin (thresholds are margin-calibrated), so it
    // competes against the least similar one rather than falling back to raw
    // cosine — which would match almost any text.
    if (competing.length === 0) competing.push(leastSimilar);
  }
  return { id: topic.id, text: topic.text, lexical: compileLexicalRule(topic.text, params.lexical), vector, background: competing, siblings: vector ? siblings : null };
}

export function dot(a: Float32Array, aOffset: number, b: Float32Array, dim: number): number {
  let s = 0;
  for (let i = 0; i < dim; i++) s += a[aOffset + i]! * b[i]!;
  return s;
}

/**
 * @param textVectors flat row-major [texts.length × dim] embeddings, or null
 *                    for lexical-only operation.
 * @param background  background topic embeddings; topics must have been
 *                    prepared with the same background. Null → raw cosine.
 */
export function decide(
  texts: readonly string[],
  textVectors: Float32Array | null,
  dim: number,
  topics: readonly PreparedTopic[],
  params: ModeParams,
  background: Background | null = null
): Decision[] {
  if (textVectors && textVectors.length !== texts.length * dim) {
    throw new Error(`expected ${texts.length * dim} embedding values, got ${textVectors.length}`);
  }
  if (background && background.vectors.length !== background.count * dim) {
    throw new Error(`expected ${background.count * dim} background values, got ${background.vectors.length}`);
  }
  const bg = new Float64Array(background?.count ?? 0);
  const ratio = params.siblingRatio ?? Infinity;
  return texts.map((text, i) => {
    let bestScore = 0;
    let bestSimilarity = 0;
    let bestTopic: PreparedTopic | null = null;
    // A topic whose sibling veto applies to this text only counts when no
    // other topic remains (then for diagnostics: it never matches).
    let bestRivalled = false;
    if (textVectors) {
      const row = textVectors.subarray(i * dim, (i + 1) * dim);
      if (background) {
        for (let k = 0; k < background.count; k++) bg[k] = dot(background.vectors, k * dim, row, dim);
      }
      bestScore = -Infinity;
      for (const t of topics) {
        if (!t.vector) continue;
        const similarity = dot(textVectors, i * dim, t.vector, dim);
        let offset = -Infinity;
        if (background) for (const k of t.background) offset = Math.max(offset, bg[k]!);
        // No background (raw-cosine model or lexical-only) → raw similarity.
        const s = offset === -Infinity ? similarity : similarity - offset;
        const vetoed = t.siblings !== null && Number.isFinite(ratio) && rivalled(row, t.siblings, ratio, dim);
        if (bestTopic === null || (bestRivalled && !vetoed) || (vetoed === bestRivalled && s > bestScore)) {
          bestScore = s;
          bestSimilarity = similarity;
          bestTopic = t;
          bestRivalled = vetoed;
        }
      }
      if (!bestTopic) bestScore = 0;
    }

    if (bestTopic && !bestRivalled && bestScore >= params.threshold && text.trim().length >= params.minSemanticChars) {
      return { matched: true, topicId: bestTopic.id, score: bestScore, similarity: bestSimilarity, via: "semantic", rivalled: false };
    }

    const lex = prepareLexicalText(text);
    for (const t of topics) {
      if (matchLexical(t.lexical, lex)) {
        return { matched: true, topicId: t.id, score: bestScore, similarity: bestSimilarity, via: "lexical", rivalled: bestRivalled };
      }
    }
    return { matched: false, topicId: null, score: bestScore, similarity: bestSimilarity, via: null, rivalled: bestRivalled };
  });
}
