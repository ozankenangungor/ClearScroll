/**
 * SigLIP text tokenizer: SentencePiece Unigram model read from the pinned
 * tokenizer.json, with the text canonicalisation SigLIP was trained with
 * (transformers' SiglipTokenizer / big_vision):
 *
 *   lowercase → remove ASCII punctuation → collapse whitespace → trim
 *   → NFKC (the model's "nmt_nfkc" normaliser, for the text that can remain)
 *   → "▁" word boundaries (Metaspace, prefix always) → Unigram (Viterbi)
 *   → append </s> → pad / truncate to 64 tokens with </s>.
 *
 * The model was trained on fixed-length (64) sequences without an attention
 * mask, so padding to 64 is part of the input contract, not an optimisation.
 * tests/unit/vision.test.ts compares ids with the reference `tokenizers`
 * implementation (fixtures from tools/vision_reference.py).
 */

export const SIGLIP_CONTEXT = 64;
export const SIGLIP_EOS = 1;
const UNK_ID = 2;
const WORD_BOUNDARY = "▁";
// Python's string.punctuation.
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

export interface UnigramModel {
  type: "Unigram";
  unk_id: number;
  vocab: [string, number][];
}

export function canonicalizeText(text: string): string {
  return text.toLowerCase().replace(PUNCTUATION, "").replace(/\s+/g, " ").trim();
}

export class SiglipTokenizer {
  private readonly pieces = new Map<string, { id: number; score: number }>();
  private readonly maxPieceChars: number;
  private readonly unkScore: number;

  constructor(model: UnigramModel) {
    if (model.type !== "Unigram" || model.unk_id !== UNK_ID) throw new Error("tokenizer: expected the SigLIP Unigram model");
    let min = Infinity;
    let maxLen = 1;
    model.vocab.forEach(([piece, score], id) => {
      this.pieces.set(piece, { id, score });
      min = Math.min(min, score);
      maxLen = Math.max(maxLen, [...piece].length);
    });
    if (this.pieces.get("</s>")?.id !== SIGLIP_EOS) throw new Error("tokenizer: unexpected </s> id");
    this.maxPieceChars = maxLen;
    // tokenizers' Unigram scores an unknown character as min_score − 10.
    this.unkScore = min - 10;
  }

  /** Exactly SIGLIP_CONTEXT token ids. */
  encode(text: string): number[] {
    const normalized = canonicalizeText(text).normalize("NFKC").replace(/ {2,}/g, " ");
    const ids: number[] = [];
    // Metaspace: every word starts with "▁" (also the first: prepend_scheme "always").
    const words = normalized.length ? normalized.split(" ").map((w) => WORD_BOUNDARY + w) : [];
    for (const word of words) {
      for (const id of this.viterbi(word)) ids.push(id);
      if (ids.length >= SIGLIP_CONTEXT - 1) break;
    }
    ids.length = Math.min(ids.length, SIGLIP_CONTEXT - 1);
    ids.push(SIGLIP_EOS);
    while (ids.length < SIGLIP_CONTEXT) ids.push(SIGLIP_EOS);
    return ids;
  }

  /** Best segmentation of one word (maximum total log probability). */
  private viterbi(word: string): number[] {
    const chars = [...word];
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    const piece = new Int32Array(n + 1).fill(-1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let matched = false;
      let s = "";
      for (let j = i; j < Math.min(n, i + this.maxPieceChars); j++) {
        s += chars[j];
        const p = this.pieces.get(s);
        if (!p) continue;
        if (j === i) matched = true;
        const score = best[i]! + p.score;
        if (score > best[j + 1]!) {
          best[j + 1] = score;
          from[j + 1] = i;
          piece[j + 1] = p.id;
        }
      }
      if (!matched) {
        const score = best[i]! + this.unkScore;
        if (score > best[i + 1]!) {
          best[i + 1] = score;
          from[i + 1] = i;
          piece[i + 1] = UNK_ID;
        }
      }
    }
    const out: number[] = [];
    for (let k = n; k > 0; k = from[k]!) out.push(piece[k]!);
    out.reverse();
    // Consecutive unknown characters are fused into one <unk> (fuse_unk).
    return out.filter((id, i) => !(id === UNK_ID && out[i - 1] === UNK_ID));
  }
}
