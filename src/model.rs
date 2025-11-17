//! BERT-tiny sentence embedder implemented natively in Burn.
//!
//! Architecture (matching `prajjwal1/bert-tiny`):
//!   - 2 transformer layers
//!   - 128 hidden dim, 2 attention heads
//!   - 512 intermediate (FFN) dim
//!   - 30522 vocab size (BERT uncased)
//!   - Mean-pooled, L2-normalized sentence embeddings (no classification head)

use burn::module::{Param, ParamId};
use burn::nn::{
    Embedding, EmbeddingConfig, LayerNorm, LayerNormConfig, Linear, LinearConfig,
};
use burn::prelude::*;

// ── Config ──────────────────────────────────────────────────────────────

#[derive(Config, Debug)]
pub struct BertTinyConfig {
    pub vocab_size: usize,
    pub hidden_size: usize,
    pub num_layers: usize,
    pub num_heads: usize,
    pub intermediate_size: usize,
    pub max_seq_len: usize,
}

impl BertTinyConfig {
    /// bert-tiny defaults: 2 layers, 128 hidden, 2 heads, 512 FFN
    pub fn default_config() -> Self {
        Self::new(30522, 128, 2, 2, 512, 128)
    }
}

// ── Embeddings ──────────────────────────────────────────────────────────

#[derive(Module, Debug)]
pub struct BertEmbeddings<B: Backend> {
    word_embeddings: Embedding<B>,
    position_embeddings: Embedding<B>,
    token_type_embeddings: Embedding<B>,
    layer_norm: LayerNorm<B>,
}

impl BertTinyConfig {
    fn init_embeddings<B: Backend>(&self, device: &B::Device) -> BertEmbeddings<B> {
        BertEmbeddings {
            word_embeddings: EmbeddingConfig::new(self.vocab_size, self.hidden_size).init(device),
            position_embeddings: EmbeddingConfig::new(self.max_seq_len, self.hidden_size)
                .init(device),
            token_type_embeddings: EmbeddingConfig::new(2, self.hidden_size).init(device),
            layer_norm: LayerNormConfig::new(self.hidden_size).init(device),
        }
    }
}

impl<B: Backend> BertEmbeddings<B> {
    fn forward(&self, input_ids: Tensor<B, 2, Int>) -> Tensor<B, 3> {
        let [batch, seq_len] = input_ids.dims();
        let device = &input_ids.device();

        let word_emb = self.word_embeddings.forward(input_ids);

        let positions: Vec<i32> = (0..seq_len as i32).collect();
        let pos_ids = Tensor::<B, 1, Int>::from_data(
            TensorData::new(positions, [seq_len]),
            device,
        )
        .unsqueeze::<2>()
        .expand([batch, seq_len]);
        let pos_emb = self.position_embeddings.forward(pos_ids);

        let tt_ids = Tensor::<B, 2, Int>::zeros([batch, seq_len], device);
        let tt_emb = self.token_type_embeddings.forward(tt_ids);

        let embeddings = word_emb + pos_emb + tt_emb;
        self.layer_norm.forward(embeddings)
    }
}

// ── Self-Attention ──────────────────────────────────────────────────────

#[derive(Module, Debug)]
pub struct BertSelfAttention<B: Backend> {
    query: Linear<B>,
    key: Linear<B>,
    value: Linear<B>,
    output_dense: Linear<B>,
    output_layer_norm: LayerNorm<B>,
    num_heads: usize,
    head_dim: usize,
}

impl BertTinyConfig {
    fn init_self_attention<B: Backend>(&self, device: &B::Device) -> BertSelfAttention<B> {
        let head_dim = self.hidden_size / self.num_heads;
        BertSelfAttention {
            query: LinearConfig::new(self.hidden_size, self.hidden_size).init(device),
            key: LinearConfig::new(self.hidden_size, self.hidden_size).init(device),
            value: LinearConfig::new(self.hidden_size, self.hidden_size).init(device),
            output_dense: LinearConfig::new(self.hidden_size, self.hidden_size).init(device),
            output_layer_norm: LayerNormConfig::new(self.hidden_size).init(device),
            num_heads: self.num_heads,
            head_dim,
        }
    }
}

impl<B: Backend> BertSelfAttention<B> {
    fn forward(
        &self,
        hidden: Tensor<B, 3>,
        attention_mask: Tensor<B, 2, Int>,
    ) -> Tensor<B, 3> {
        let [batch, seq_len, _] = hidden.dims();

        let q = self.query.forward(hidden.clone());
        let k = self.key.forward(hidden.clone());
        let v = self.value.forward(hidden.clone());

        let q = q
            .reshape([batch, seq_len, self.num_heads, self.head_dim])
            .swap_dims(1, 2);
        let k = k
            .reshape([batch, seq_len, self.num_heads, self.head_dim])
            .swap_dims(1, 2);
        let v = v
            .reshape([batch, seq_len, self.num_heads, self.head_dim])
            .swap_dims(1, 2);

        let scale = (self.head_dim as f64).sqrt();
        let scores = q.matmul(k.swap_dims(2, 3)) / scale;

        let mask_float: Tensor<B, 2> = attention_mask.float();
        let mask_expanded = mask_float
            .unsqueeze_dim::<3>(1)
            .unsqueeze_dim::<4>(2);
        let mask_bias = (Tensor::ones_like(&mask_expanded) - mask_expanded) * (-10000.0);
        let masked_scores = scores + mask_bias;

        let attn_weights = burn::tensor::activation::softmax(masked_scores, 3);
        let context = attn_weights.matmul(v);

        let context = context
            .swap_dims(1, 2)
            .reshape([batch, seq_len, self.num_heads * self.head_dim]);

        let output = self.output_dense.forward(context);
        self.output_layer_norm.forward(output + hidden)
    }
}

// ── Feed-Forward Network ────────────────────────────────────────────────

#[derive(Module, Debug)]
pub struct BertFFN<B: Backend> {
    intermediate: Linear<B>,
    output_dense: Linear<B>,
    layer_norm: LayerNorm<B>,
}

impl BertTinyConfig {
    fn init_ffn<B: Backend>(&self, device: &B::Device) -> BertFFN<B> {
        BertFFN {
            intermediate: LinearConfig::new(self.hidden_size, self.intermediate_size).init(device),
            output_dense: LinearConfig::new(self.intermediate_size, self.hidden_size).init(device),
            layer_norm: LayerNormConfig::new(self.hidden_size).init(device),
        }
    }
}

impl<B: Backend> BertFFN<B> {
    fn forward(&self, hidden: Tensor<B, 3>) -> Tensor<B, 3> {
        let intermediate = self.intermediate.forward(hidden.clone());
        let activated = burn::tensor::activation::gelu(intermediate);
        let output = self.output_dense.forward(activated);
        self.layer_norm.forward(output + hidden)
    }
}

// ── Transformer Layer ───────────────────────────────────────────────────

#[derive(Module, Debug)]
pub struct BertLayer<B: Backend> {
    attention: BertSelfAttention<B>,
    ffn: BertFFN<B>,
}

impl BertTinyConfig {
    fn init_layer<B: Backend>(&self, device: &B::Device) -> BertLayer<B> {
        BertLayer {
            attention: self.init_self_attention(device),
            ffn: self.init_ffn(device),
        }
    }
}

impl<B: Backend> BertLayer<B> {
    fn forward(
        &self,
        hidden: Tensor<B, 3>,
        attention_mask: Tensor<B, 2, Int>,
    ) -> Tensor<B, 3> {
        let attended = self.attention.forward(hidden, attention_mask);
        self.ffn.forward(attended)
    }
}

// ── Text Embedder (Sentence Encoder) ────────────────────────────────────

#[derive(Module, Debug)]
pub struct TextEmbedder<B: Backend> {
    embeddings: BertEmbeddings<B>,
    layers: Vec<BertLayer<B>>,
}

impl BertTinyConfig {
    pub fn init_model<B: Backend>(&self, device: &B::Device) -> TextEmbedder<B> {
        let layers = (0..self.num_layers)
            .map(|_| self.init_layer(device))
            .collect();

        TextEmbedder {
            embeddings: self.init_embeddings(device),
            layers,
        }
    }
}

impl<B: Backend> TextEmbedder<B> {
    /// Forward pass: (input_ids, attention_mask) → L2-normalized embeddings [batch, hidden_size]
    pub fn forward(
        &self,
        input_ids: Tensor<B, 2, Int>,
        attention_mask: Tensor<B, 2, Int>,
    ) -> Tensor<B, 2> {
        let mut hidden = self.embeddings.forward(input_ids);

        for layer in &self.layers {
            hidden = layer.forward(hidden, attention_mask.clone());
        }

        // Mean pooling over non-padding positions
        let mask_float: Tensor<B, 3> = attention_mask
            .float()
            .unsqueeze_dim(2);
        let masked = hidden * mask_float.clone();
        let sum = masked.sum_dim(1);
        let count = mask_float.sum_dim(1).clamp_min(1.0);
        let pooled: Tensor<B, 2> = (sum / count).squeeze_dim(1);

        // L2 normalize: embedding / ||embedding||
        l2_normalize(pooled)
    }
}

// ── Vector Operations ───────────────────────────────────────────────────

/// L2-normalize each row of a [batch, dim] tensor.
fn l2_normalize<B: Backend>(t: Tensor<B, 2>) -> Tensor<B, 2> {
    let norm = t.clone().powf_scalar(2.0).sum_dim(1).sqrt();
    let norm_clamped = norm.clamp_min(1e-12); // avoid division by zero
    t / norm_clamped
}

/// Cosine similarity between a reference [1, dim] and a batch [batch, dim].
/// Both inputs are assumed to already be L2-normalized, so cosine = dot product.
pub fn cosine_similarity_batch<B: Backend>(
    reference: Tensor<B, 2>,
    batch: Tensor<B, 2>,
) -> Tensor<B, 1> {
    // reference: [1, dim], batch: [N, dim]
    // dot product per row: sum(ref * batch, dim=1) → [N]
    let dots: Tensor<B, 2> = (reference * batch).sum_dim(1);
    dots.squeeze_dim::<1>(1)
}

// ── Weight Injection ─────────────────────────────────────────────────

/// Load pretrained encoder weights from raw f32 little-endian bytes.
///
/// The byte layout must match the order produced by `export_weights.py`:
///   embeddings (word, position, token_type, LN) →
///   layer 0 (attention Q/K/V/O + LN, FFN inter/out + LN) →
///   layer 1 (same)
pub fn load_pretrained_weights<B: Backend>(
    model: &mut TextEmbedder<B>,
    bytes: &[u8],
    device: &B::Device,
) {
    let mut offset = 0usize;

    let mut read_f32 = |n: usize| -> Vec<f32> {
        let size = n * 4;
        let slice = &bytes[offset..offset + size];
        offset += size;
        slice
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect()
    };

    macro_rules! param2 {
        ($rows:expr, $cols:expr) => {{
            let data = read_f32($rows * $cols);
            let tensor = Tensor::<B, 2>::from_data(
                TensorData::new(data, [$rows, $cols]),
                device,
            );
            Param::initialized(ParamId::new(), tensor)
        }};
    }

    macro_rules! param1 {
        ($len:expr) => {{
            let data = read_f32($len);
            let tensor = Tensor::<B, 1>::from_data(
                TensorData::new(data, [$len]),
                device,
            );
            Param::initialized(ParamId::new(), tensor)
        }};
    }

    // ── Embeddings ─────────────────────────────────────────────────
    model.embeddings.word_embeddings.weight = param2!(30522, 128);
    model.embeddings.position_embeddings.weight = param2!(128, 128);
    model.embeddings.token_type_embeddings.weight = param2!(2, 128);
    model.embeddings.layer_norm.gamma = param1!(128);
    model.embeddings.layer_norm.beta = Some(param1!(128));

    // ── Encoder Layers ─────────────────────────────────────────────
    for layer in &mut model.layers {
        layer.attention.query.weight = param2!(128, 128);
        layer.attention.query.bias = Some(param1!(128));
        layer.attention.key.weight = param2!(128, 128);
        layer.attention.key.bias = Some(param1!(128));
        layer.attention.value.weight = param2!(128, 128);
        layer.attention.value.bias = Some(param1!(128));
        layer.attention.output_dense.weight = param2!(128, 128);
        layer.attention.output_dense.bias = Some(param1!(128));
        layer.attention.output_layer_norm.gamma = param1!(128);
        layer.attention.output_layer_norm.beta = Some(param1!(128));
        layer.ffn.intermediate.weight = param2!(128, 512);
        layer.ffn.intermediate.bias = Some(param1!(512));
        layer.ffn.output_dense.weight = param2!(512, 128);
        layer.ffn.output_dense.bias = Some(param1!(128));
        layer.ffn.layer_norm.gamma = param1!(128);
        layer.ffn.layer_norm.beta = Some(param1!(128));
    }

    assert_eq!(
        offset,
        bytes.len(),
        "Weight file size mismatch: consumed {} of {} bytes",
        offset,
        bytes.len()
    );
}
