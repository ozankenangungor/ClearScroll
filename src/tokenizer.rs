//! Pure-Rust WordPiece tokenizer compatible with BERT's `vocab.txt`.
//!
//! Zero C dependencies — guaranteed to compile to `wasm32-unknown-unknown`.
//! Implements BERT's BasicTokenizer + WordPieceTokenizer pipeline:
//!   lowercase → strip accents → whitespace split → punctuation split → wordpiece lookup

use std::collections::HashMap;

/// BERT vocabulary embedded at compile time.
const VOCAB_TXT: &str = include_str!("../model/vocab.txt");

/// Special token IDs (standard BERT uncased vocab positions).
const PAD_ID: usize = 0;
const UNK_ID: usize = 100;
const CLS_ID: usize = 101;
const SEP_ID: usize = 102;

const MAX_WORD_LEN: usize = 200;

pub struct WordPieceTokenizer {
    vocab: HashMap<String, usize>,
}

impl WordPieceTokenizer {
    /// Parse `vocab.txt` into a token→ID map.
    pub fn new() -> Self {
        let mut vocab = HashMap::with_capacity(32_000);
        for (id, line) in VOCAB_TXT.lines().enumerate() {
            vocab.insert(line.to_string(), id);
        }
        Self { vocab }
    }

    /// Full encode pipeline: text → (input_ids, attention_mask), both padded to `max_len`.
    pub fn encode(&self, text: &str, max_len: usize) -> (Vec<usize>, Vec<i32>) {
        let mut ids = Vec::with_capacity(max_len);
        ids.push(CLS_ID);

        let tokens = basic_tokenize(text);
        let max_content = max_len.saturating_sub(2); // room for [CLS] + [SEP]

        for token in &tokens {
            if ids.len() - 1 >= max_content {
                break;
            }
            let sub_ids = self.wordpiece(token);
            for sid in sub_ids {
                if ids.len() - 1 >= max_content {
                    break;
                }
                ids.push(sid);
            }
        }

        ids.push(SEP_ID);

        let real_len = ids.len();
        let mut mask = vec![1i32; real_len];

        // Pad to max_len
        ids.resize(max_len, PAD_ID);
        mask.resize(max_len, 0);

        (ids, mask)
    }

    /// Greedy longest-match WordPiece algorithm.
    fn wordpiece(&self, token: &str) -> Vec<usize> {
        if token.len() > MAX_WORD_LEN {
            return vec![UNK_ID];
        }

        let chars: Vec<char> = token.chars().collect();
        let mut result = Vec::new();
        let mut start = 0;

        while start < chars.len() {
            let mut end = chars.len();
            let mut found = false;

            while start < end {
                let substr: String = if start == 0 {
                    chars[start..end].iter().collect()
                } else {
                    let mut s = String::from("##");
                    s.extend(&chars[start..end]);
                    s
                };

                if let Some(&id) = self.vocab.get(&substr) {
                    result.push(id);
                    found = true;
                    start = end;
                    break;
                }
                end -= 1;
            }

            if !found {
                return vec![UNK_ID];
            }
        }

        result
    }
}

/// BERT BasicTokenizer: lowercase → strip accents → split on whitespace + punctuation.
fn basic_tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();

    for ch in text.chars() {
        // Normalize: lowercase, skip control chars, collapse whitespace
        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }

        if ch.is_control() {
            continue;
        }

        let lower = ch.to_lowercase().next().unwrap_or(ch);

        // Strip accents: skip combining marks (Unicode category Mn)
        if is_accent(lower) {
            continue;
        }

        // Split on punctuation
        if is_punctuation(lower) {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            tokens.push(lower.to_string());
        } else {
            current.push(lower);
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

/// Check if char is a Unicode combining mark (accent).
fn is_accent(c: char) -> bool {
    // Unicode Mn (Mark, Nonspacing) range — covers common Latin accents
    matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

/// Check if char is punctuation (BERT definition: ASCII punct + Unicode Pc/Pd/Pe/Pf/Pi/Po/Ps).
fn is_punctuation(c: char) -> bool {
    let cp = c as u32;
    // ASCII punctuation ranges
    if (0x21..=0x2F).contains(&cp)
        || (0x3A..=0x40).contains(&cp)
        || (0x5B..=0x60).contains(&cp)
        || (0x7B..=0x7E).contains(&cp)
    {
        return true;
    }
    // Unicode general punctuation
    if cp > 127 {
        // Simple heuristic: treat Unicode category P* as punctuation
        return c.is_ascii_punctuation()
            || matches!(
                cp,
                0x2000..=0x206F   // General Punctuation
                | 0x2E00..=0x2E7F // Supplemental Punctuation
                | 0x3000..=0x303F // CJK Symbols and Punctuation
                | 0xFE30..=0xFE4F // CJK Compatibility Forms
                | 0xFE50..=0xFE6F // Small Form Variants
                | 0xFF00..=0xFF0F // Fullwidth ASCII Punctuation
                | 0xFF1A..=0xFF20
                | 0xFF3B..=0xFF40
                | 0xFF5B..=0xFF65
            );
    }
    false
}

/// Tokenize a batch of texts. Returns (input_ids, attention_masks).
pub fn tokenize_batch(
    texts: &[String],
    max_seq_len: usize,
) -> (Vec<Vec<usize>>, Vec<Vec<i32>>) {
    let tokenizer = WordPieceTokenizer::new();
    let mut all_ids = Vec::with_capacity(texts.len());
    let mut all_masks = Vec::with_capacity(texts.len());

    for text in texts {
        let (ids, mask) = tokenizer.encode(text, max_seq_len);
        all_ids.push(ids);
        all_masks.push(mask);
    }

    (all_ids, all_masks)
}
