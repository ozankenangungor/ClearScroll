/**
 * Sibling veto: telling a topic apart from its neighbouring subjects.
 *
 * Margin scoring (classifier.ts) compares a text with the user's topic and
 * with generic background topics. Background topics close to the topic are
 * dropped as near-synonyms, so nothing speaks for the subjects users most
 * often confuse with theirs: for "football", rugby and basketball texts are
 * closer to "football" than to cooking or travel and match; for "cats", so
 * do dogs (measured on the real-world evaluation, docs/MODEL.md).
 *
 * A cosine cutoff cannot pick those neighbours: "cats" is closer to
 * "kittens" (0.78) than to "dogs" (0.72), and "football" closer to "sports"
 * (0.79) than to "basketball" (0.68). Instead a short list of general domains
 * (topic-siblings.json) says what is a sibling of what:
 *
 *   1. Each part of the topic ("cats", or "football" and "basketball" in
 *      "football and basketball") is anchored to its most similar member, if
 *      that member is clearly what it names (cosine ≥ ANCHOR_MIN).
 *   2. A part closer to its group's own label than to any member ("sports",
 *      "pets") is broad: that group contributes no rivals at all.
 *   3. The topic, its parts, their anchors and members nearly as close as the
 *      anchor are the topic's side; the other members of the anchored groups
 *      are its rivals.
 *
 * A text that the classifier would match semantically is not matched when it
 * is clearly closer to a rival than to the topic's side (best rival
 * similarity > ratio × best own similarity, ratio per mode in models.ts).
 * Keyword matches are never vetoed. Topics without a plan (no clear anchor,
 * broad topics, people, places …) behave exactly as before.
 */

import siblingData from "./topic-siblings.json" with { type: "json" };

export interface SiblingGroup {
  labels: readonly string[];
  members: readonly string[];
}

export const SIBLING_GROUPS: readonly SiblingGroup[] = siblingData.groups;

/** Every phrase a plan may need, in a fixed order (model.json stores their vectors in this order). */
export const SIBLING_PHRASES: readonly string[] = [...new Set(SIBLING_GROUPS.flatMap((g) => [...g.labels, ...g.members]))];

/** A topic part anchors to a member at least this similar (otherwise: no plan for that part). */
export const ANCHOR_MIN = 0.6;
/** Members at least this similar to a part are the same subject (synonyms), never rivals. */
export const SYNONYM_MIN = 0.8;
/** Members within this distance of the anchor are also on the topic's side (ambiguous anchors). */
export const NEAR_ANCHOR = 0.1;
/** A part is broad if a group label is at least this close to it as its anchor (minus this margin). */
export const BROAD_MARGIN = 0.02;

/** Embeddings of SIBLING_PHRASES: flat row-major [count × dim], L2-normalised. */
export interface SiblingTable {
  vectors: Float32Array;
  count: number;
}

export interface SiblingPlan {
  /** Rows the topic's side is scored with: the topic, its parts, their anchors. */
  own: Float32Array;
  ownCount: number;
  rivals: Float32Array;
  rivalCount: number;
  /** For diagnostics and tests. */
  anchors: string[];
  rivalNames: string[];
}

/**
 * The separately anchored parts of a topic: "football and basketball",
 * "cats, dogs", "crypto & web3", "TV/film" → their parts; anything else → [topic].
 */
export function topicParts(topic: string): string[] {
  const parts = topic
    .split(/\s*(?:,|&|\/|\+|\band\b|\bor\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  return parts.length > 1 ? parts : [topic.trim()];
}

function dotRow(table: Float32Array, row: number, v: Float32Array, dim: number): number {
  let s = 0;
  const off = row * dim;
  for (let i = 0; i < dim; i++) s += table[off + i]! * v[i]!;
  return s;
}

/**
 * @param topicVector embedding of the whole topic
 * @param partVectors embeddings of topicParts(topic), same order (for a
 *                    single-part topic: [topicVector])
 * @returns null when the topic has no rivals (behaviour unchanged)
 */
export function planSiblings(topicVector: Float32Array, partVectors: readonly Float32Array[], table: SiblingTable, dim: number): SiblingPlan | null {
  if (table.vectors.length !== table.count * dim || table.count !== SIBLING_PHRASES.length) return null;
  const index = new Map(SIBLING_PHRASES.map((p, i) => [p, i]));
  const own = new Set<number>();
  const anchors: string[] = [];
  const anchored = new Set<number>();
  const broad = new Set<number>();
  for (const part of partVectors) {
    let best = { group: -1, member: -1, sim: -Infinity };
    SIBLING_GROUPS.forEach((g, gi) => {
      for (const m of g.members) {
        const row = index.get(m)!;
        const sim = dotRow(table.vectors, row, part, dim);
        if (sim > best.sim) best = { group: gi, member: row, sim };
      }
    });
    if (best.group < 0 || best.sim < ANCHOR_MIN) continue;
    const g = SIBLING_GROUPS[best.group]!;
    const label = Math.max(...g.labels.map((l) => dotRow(table.vectors, index.get(l)!, part, dim)));
    if (label >= best.sim - BROAD_MARGIN) {
      broad.add(best.group);
      continue;
    }
    anchored.add(best.group);
    anchors.push(SIBLING_PHRASES[best.member]!);
    const sameSubject = Math.min(SYNONYM_MIN, best.sim - NEAR_ANCHOR);
    for (const m of g.members) {
      const row = index.get(m)!;
      if (row === best.member || dotRow(table.vectors, row, part, dim) >= sameSubject) own.add(row);
    }
  }
  const rivals: number[] = [];
  for (const gi of anchored) {
    if (broad.has(gi)) continue;
    for (const m of SIBLING_GROUPS[gi]!.members) {
      const row = index.get(m)!;
      if (!own.has(row) && !rivals.includes(row)) rivals.push(row);
    }
  }
  if (rivals.length === 0) return null;
  const ownRows = [topicVector, ...(partVectors.length > 1 ? partVectors : []), ...[...own].map((r) => table.vectors.subarray(r * dim, (r + 1) * dim))];
  const ownFlat = new Float32Array(ownRows.length * dim);
  ownRows.forEach((v, i) => ownFlat.set(v, i * dim));
  const rivalFlat = new Float32Array(rivals.length * dim);
  rivals.forEach((r, i) => rivalFlat.set(table.vectors.subarray(r * dim, (r + 1) * dim), i * dim));
  return { own: ownFlat, ownCount: ownRows.length, rivals: rivalFlat, rivalCount: rivals.length, anchors, rivalNames: rivals.map((r) => SIBLING_PHRASES[r]!) };
}

/** True when the text (embedding `text`) is clearly about a rival: max rival > ratio × max own. */
export function rivalled(text: Float32Array, plan: SiblingPlan, ratio: number, dim: number): boolean {
  let own = -Infinity;
  for (let i = 0; i < plan.ownCount; i++) own = Math.max(own, dotRow(plan.own, i, text, dim));
  let rival = -Infinity;
  for (let i = 0; i < plan.rivalCount; i++) rival = Math.max(rival, dotRow(plan.rivals, i, text, dim));
  return rival > own * ratio;
}
