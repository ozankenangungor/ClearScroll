use std::collections::HashMap;

pub struct SimpleTokenizer {
    vocab: HashMap<String, usize>,
    unk_id: usize,
    pad_id: usize,
    cls_id: usize,
    sep_id: usize,
}

impl SimpleTokenizer {
    pub fn new() -> Self {
        let mut vocab = HashMap::new();
        vocab.insert("[PAD]".into(), 0);
        vocab.insert("[UNK]".into(), 1);
        vocab.insert("[CLS]".into(), 2);
        vocab.insert("[SEP]".into(), 3);

        let common = [
            "the", "a", "is", "are", "this", "that", "it", "hello", "world", "good", "bad",
            "spam", "not", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with",
        ];
        for (i, word) in common.iter().enumerate() {
            vocab.insert((*word).into(), i + 4);
        }

        Self {
            vocab,
            unk_id: 1,
            pad_id: 0,
            cls_id: 2,
            sep_id: 3,
        }
    }

    /// Tokenize a single string into padded token IDs with [CLS] and [SEP].
    pub fn tokenize(&self, text: &str, max_len: usize) -> Vec<usize> {
        let mut ids = Vec::with_capacity(max_len);
        ids.push(self.cls_id);

        let max_tokens = max_len.saturating_sub(2);
        for token in text.split_whitespace().take(max_tokens) {
            let lower = token.to_lowercase();
            let id = self.vocab.get(&lower).copied().unwrap_or(self.unk_id);
            ids.push(id);
        }

        ids.push(self.sep_id);
        ids.resize(max_len, self.pad_id);
        ids
    }
}

/// Tokenize a batch of texts into a 2D token ID matrix [batch_size, max_seq_len].
pub fn tokenize_batch(texts: &[String], max_seq_len: usize) -> Vec<Vec<usize>> {
    let tokenizer = SimpleTokenizer::new();
    texts
        .iter()
        .map(|text| tokenizer.tokenize(text, max_seq_len))
        .collect()
}
