/**
 * Lexical topic matching: whole-phrase match, or enough of the topic's
 * significant words present in the text. Used on its own when semantic
 * inference is unavailable and as a complement to it otherwise.
 */

export interface LexicalParams {
  /** Topic words shorter than this are ignored (drops "and", "the", …). */
  minTokenLen: number;
  /** Multi-word topics need at least this many of their words present … */
  minMultiTokenMatch: number;
  /** … and at least this fraction of them. */
  multiTokenMatchRatio: number;
}

export interface LexicalRule {
  phrase: RegExp | null;
  tokens: string[];
  required: number;
}

/** NFKD, strip combining marks, lowercase, collapse whitespace. */
export function normalizeLexical(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function words(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function compileLexicalRule(topic: string, params: LexicalParams): LexicalRule {
  const norm = normalizeLexical(topic);
  if (!norm) return { phrase: null, tokens: [], required: Infinity };
  const phrase = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegex(norm).replace(/\s+/g, "\\s+")}(?:[^\\p{L}\\p{N}]|$)`,
    "u"
  );
  const tokens = [...new Set(words(norm).filter((w) => w.length >= params.minTokenLen))];
  const required =
    tokens.length <= 1
      ? tokens.length
      : Math.max(params.minMultiTokenMatch, Math.ceil(tokens.length * params.multiTokenMatchRatio));
  return { phrase, tokens, required };
}

/** Pre-normalised text so one text can be checked against many topics cheaply. */
export interface LexicalText {
  normalized: string;
  wordSet: Set<string>;
}

export function prepareLexicalText(text: string): LexicalText {
  const normalized = normalizeLexical(text);
  return { normalized, wordSet: new Set(words(normalized)) };
}

export function matchLexical(rule: LexicalRule, text: LexicalText): boolean {
  if (rule.phrase && rule.phrase.test(text.normalized)) return true;
  if (rule.tokens.length === 0) return false;
  let hits = 0;
  for (const t of rule.tokens) if (text.wordSet.has(t)) hits++;
  return hits >= rule.required;
}
