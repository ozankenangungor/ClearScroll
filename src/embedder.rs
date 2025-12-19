//! Text → embedding pipeline: tokenization, dynamic padding, encoder forward.

use burn::prelude::*;

use crate::model::BertEncoder;
use crate::tokenizer::{Encoding, WordPieceTokenizer};
use crate::weights::WeightFile;

/// Default number of texts per forward pass on CPU. Texts are sorted by
/// length first, so small chunks keep padding low: measured in Chromium
/// (WASM SIMD), 8 instead of 32 cut mixed-length batch latency by 36%.
/// GPUs prefer large batches; see [`GPU_CHUNK`].
pub const MAX_CHUNK: usize = 8;
/// Chunk size for the WebGPU backend (parallel hardware, launch overhead).
pub const GPU_CHUNK: usize = 32;

pub struct Embedder<B: Backend> {
    encoder: BertEncoder<B>,
    tokenizer: WordPieceTokenizer,
    device: B::Device,
    max_len: usize,
    chunk: usize,
}

/// One forward-pass worth of input, already moved to the device.
pub struct PreparedChunk<B: Backend> {
    ids: Tensor<B, 2, Int>,
    mask: Tensor<B, 2>,
}

/// Execution plan: texts grouped into chunks of similar token length so that
/// padding (and thus wasted compute) is minimal. `order[k]` is the original
/// index of the k-th text in chunk order.
struct Plan {
    encodings: Vec<Encoding>,
    order: Vec<usize>,
}

impl<B: Backend> Embedder<B> {
    pub fn new(weights: &[u8], vocab_txt: &str, device: B::Device) -> Result<Self, String> {
        let file = WeightFile::parse(weights).map_err(|e| e.to_string())?;
        let tokenizer = WordPieceTokenizer::from_vocab(vocab_txt).map_err(|e| e.to_string())?;
        if tokenizer.vocab_size() != file.config.vocab_size {
            return Err(format!(
                "vocab.txt has {} tokens but the model expects {}",
                tokenizer.vocab_size(),
                file.config.vocab_size
            ));
        }
        let encoder = BertEncoder::load(&file, &device).map_err(|e| e.to_string())?;
        let max_len = file.config.max_position;
        Ok(Self {
            encoder,
            tokenizer,
            device,
            max_len,
            chunk: MAX_CHUNK,
        })
    }

    /// Override the number of texts per forward pass (>= 1).
    pub fn with_chunk_size(mut self, chunk: usize) -> Self {
        self.chunk = chunk.max(1);
        self
    }

    pub fn dim(&self) -> usize {
        self.encoder.config().hidden_size
    }

    pub fn tokenize(&self, text: &str) -> Encoding {
        self.tokenizer.encode(text, self.max_len)
    }

    fn plan(&self, texts: &[String]) -> Plan {
        let encodings: Vec<Encoding> = texts.iter().map(|t| self.tokenize(t)).collect();
        let mut order: Vec<usize> = (0..texts.len()).collect();
        // Stable sort keeps equal-length texts in input order (deterministic).
        order.sort_by_key(|&i| encodings[i].len());
        Plan { encodings, order }
    }

    /// Pad a chunk of encodings to its longest sequence.
    fn prepare(&self, chunk: &[&Encoding]) -> PreparedChunk<B> {
        let seq = chunk.iter().map(|e| e.len()).max().unwrap_or(2);
        let pad = self.tokenizer.pad_id() as i32;
        let mut ids = Vec::with_capacity(chunk.len() * seq);
        let mut mask = Vec::with_capacity(chunk.len() * seq);
        for enc in chunk {
            ids.extend(enc.iter().map(|&id| id as i32));
            ids.extend(std::iter::repeat_n(pad, seq - enc.len()));
            mask.extend(std::iter::repeat_n(1.0f32, enc.len()));
            mask.extend(std::iter::repeat_n(0.0f32, seq - enc.len()));
        }
        let batch = chunk.len();
        PreparedChunk {
            ids: Tensor::from_data(TensorData::new(ids, [batch, seq]), &self.device),
            mask: Tensor::from_data(TensorData::new(mask, [batch, seq]), &self.device),
        }
    }

    fn forward(&self, chunk: PreparedChunk<B>) -> Tensor<B, 2> {
        self.encoder.forward(chunk.ids, chunk.mask)
    }

    /// Copy one chunk's rows back to their original positions.
    fn scatter(&self, out: &mut [f32], rows: &[usize], data: &TensorData) {
        let dim = self.dim();
        for (r, v) in data.iter::<f32>().enumerate() {
            out[rows[r / dim] * dim + r % dim] = v;
        }
    }

    /// Synchronous embedding (native and CPU backends). Returns a flat
    /// row-major [texts.len() × dim] buffer in input order.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn embed_sync(&self, texts: &[String]) -> Result<Vec<f32>, String> {
        let plan = self.plan(texts);
        let mut out = vec![0.0; texts.len() * self.dim()];
        for rows in plan.order.chunks(self.chunk) {
            let chunk: Vec<&Encoding> = rows.iter().map(|&i| &plan.encodings[i]).collect();
            let data = self.forward(self.prepare(&chunk)).into_data();
            self.scatter(&mut out, rows, &data);
        }
        Ok(out)
    }

    /// Asynchronous embedding; required for WebGPU readback in the browser.
    pub async fn embed(&self, texts: &[String]) -> Result<Vec<f32>, String> {
        let plan = self.plan(texts);
        let mut out = vec![0.0; texts.len() * self.dim()];
        for rows in plan.order.chunks(self.chunk) {
            let chunk: Vec<&Encoding> = rows.iter().map(|&i| &plan.encodings[i]).collect();
            let data = self
                .forward(self.prepare(&chunk))
                .into_data_async()
                .await
                .map_err(|e| format!("tensor readback failed: {e:?}"))?;
            self.scatter(&mut out, rows, &data);
        }
        Ok(out)
    }
}

#[cfg(all(test, feature = "cpu"))]
mod tests {
    use super::*;
    use crate::weights::{encode, tiny_config};
    use burn::backend::NdArray;

    type B = NdArray;

    /// Deterministic pseudo-random weights for a tiny synthetic model.
    fn tiny_embedder() -> Embedder<B> {
        let cfg = tiny_config();
        let mut state = 0x2545_f491u32;
        let values: Vec<f32> = (0..cfg.param_count())
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state as f32 / u32::MAX as f32) - 0.5
            })
            .collect();
        let bytes = encode(&cfg, &values);
        let vocab = "[PAD]\n[UNK]\n[CLS]\n[SEP]\na\nb\nc\nd\ne\nf\ng\nh\n##a\n##b\nab\ncd";
        Embedder::new(&bytes, vocab, Default::default()).unwrap()
    }

    fn rows(flat: &[f32], dim: usize) -> Vec<Vec<f32>> {
        flat.chunks(dim).map(<[f32]>::to_vec).collect()
    }

    #[test]
    fn output_shape_and_unit_norm() {
        let e = tiny_embedder();
        let texts: Vec<String> = ["a b", "cd ab", "h"].map(String::from).to_vec();
        let flat = e.embed_sync(&texts).unwrap();
        assert_eq!(flat.len(), 3 * e.dim());
        for row in rows(&flat, e.dim()) {
            let norm: f32 = row.iter().map(|v| v * v).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 1e-5, "norm={norm}");
            assert!(row.iter().all(|v| v.is_finite()));
        }
    }

    #[test]
    fn empty_batch_returns_empty() {
        assert!(tiny_embedder().embed_sync(&[]).unwrap().is_empty());
    }

    #[test]
    fn empty_text_still_produces_finite_embedding() {
        let flat = tiny_embedder().embed_sync(&[String::new()]).unwrap();
        assert!(flat.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn padding_does_not_change_embeddings() {
        // The same text embedded alone and next to a much longer text (which
        // forces padding) must produce the same vector.
        let e = tiny_embedder();
        let alone = e.embed_sync(&["a".to_string()]).unwrap();
        let batched = e
            .embed_sync(&["a".to_string(), "a b c d e f g h".to_string()])
            .unwrap();
        for (x, y) in alone.iter().zip(&batched[..e.dim()]) {
            assert!((x - y).abs() < 1e-5, "{x} vs {y}");
        }
    }

    #[test]
    fn chunking_matches_single_pass() {
        let e = tiny_embedder();
        let texts: Vec<String> = (0..MAX_CHUNK + 5)
            .map(|i| ["a", "b c", "d e f"][i % 3].to_string())
            .collect();
        let flat = e.embed_sync(&texts).unwrap();
        let first = e.embed_sync(&texts[..1]).unwrap();
        let last = e.embed_sync(&texts[texts.len() - 1..]).unwrap();
        assert_eq!(flat.len(), texts.len() * e.dim());
        for (x, y) in first.iter().zip(&flat[..e.dim()]) {
            assert!((x - y).abs() < 1e-5);
        }
        for (x, y) in last.iter().zip(&flat[flat.len() - e.dim()..]) {
            assert!((x - y).abs() < 1e-5);
        }
    }

    #[test]
    fn length_sorting_preserves_input_order() {
        let e = tiny_embedder();
        let texts: Vec<String> = ["a b c d e f g h", "a", "cd ab h", "b"]
            .map(String::from)
            .to_vec();
        let together = e.embed_sync(&texts).unwrap();
        for (i, t) in texts.iter().enumerate() {
            let alone = e.embed_sync(std::slice::from_ref(t)).unwrap();
            for (x, y) in alone.iter().zip(&together[i * e.dim()..(i + 1) * e.dim()]) {
                assert!((x - y).abs() < 1e-5, "text {i}: {x} vs {y}");
            }
        }
    }

    #[test]
    fn truncates_overlong_input_to_position_table() {
        let e = tiny_embedder();
        // max_position = 10 in the tiny config; this would index out of range
        // without truncation.
        let flat = e.embed_sync(&["a ".repeat(50)]).unwrap();
        assert_eq!(flat.len(), e.dim());
    }

    #[test]
    fn rejects_vocab_size_mismatch() {
        let cfg = tiny_config();
        let bytes = encode(&cfg, &vec![0.1; cfg.param_count()]);
        let err = Embedder::<B>::new(&bytes, "[PAD]\n[UNK]\n[CLS]\n[SEP]", Default::default())
            .err()
            .unwrap();
        assert!(err.contains("vocab.txt has 4 tokens"), "{err}");
    }
}
