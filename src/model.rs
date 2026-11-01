//! BERT encoder (inference only) implemented on Burn tensors.
//!
//! Matches Hugging Face `BertModel` with absolute position embeddings and
//! exact (erf) GELU, followed by attention-masked mean pooling and L2
//! normalisation — the same pooling `sentence-transformers` applies to
//! MiniLM models.
//!
//! Weights come from a validated [`WeightFile`]; nothing is randomly
//! initialised, so a broken artifact fails loudly instead of producing
//! plausible-looking garbage.

use burn::prelude::*;

use crate::weights::{BertConfig, TensorReader, WeightError, WeightFile};

struct LayerNorm<B: Backend> {
    gamma: Tensor<B, 1>,
    beta: Tensor<B, 1>,
}

struct Dense<B: Backend> {
    /// Stored as [in, out] (transposed by the exporter).
    weight: Tensor<B, 2>,
    bias: Tensor<B, 1>,
}

struct Layer<B: Backend> {
    query: Dense<B>,
    key: Dense<B>,
    value: Dense<B>,
    attn_out: Dense<B>,
    attn_norm: LayerNorm<B>,
    ffn_in: Dense<B>,
    ffn_out: Dense<B>,
    ffn_norm: LayerNorm<B>,
}

pub struct BertEncoder<B: Backend> {
    config: BertConfig,
    word_embeddings: Tensor<B, 2>,
    position_embeddings: Tensor<B, 2>,
    token_type_embeddings: Tensor<B, 2>,
    embed_norm: LayerNorm<B>,
    layers: Vec<Layer<B>>,
}

struct Loader<'a, 'd, B: Backend> {
    reader: TensorReader<'a>,
    device: &'d B::Device,
}

impl<B: Backend> Loader<'_, '_, B> {
    fn t1(&mut self, n: usize) -> Result<Tensor<B, 1>, WeightError> {
        let data = self.reader.take(n)?;
        Ok(Tensor::from_data(TensorData::new(data, [n]), self.device))
    }

    fn t2(&mut self, rows: usize, cols: usize) -> Result<Tensor<B, 2>, WeightError> {
        let data = self.reader.take(rows * cols)?;
        Ok(Tensor::from_data(
            TensorData::new(data, [rows, cols]),
            self.device,
        ))
    }

    fn dense(&mut self, inputs: usize, outputs: usize) -> Result<Dense<B>, WeightError> {
        Ok(Dense {
            weight: self.t2(inputs, outputs)?,
            bias: self.t1(outputs)?,
        })
    }

    fn norm(&mut self, n: usize) -> Result<LayerNorm<B>, WeightError> {
        Ok(LayerNorm {
            gamma: self.t1(n)?,
            beta: self.t1(n)?,
        })
    }
}

impl<B: Backend> BertEncoder<B> {
    /// Build the encoder from a CSWT weight file. Tensor order must match
    /// `tensor_order()` in `tools/prepare_model.py`.
    pub fn load(file: &WeightFile<'_>, device: &B::Device) -> Result<Self, WeightError> {
        let c = file.config.clone();
        let (h, i) = (c.hidden_size, c.intermediate_size);
        let mut ld = Loader::<B> {
            reader: file.reader(),
            device,
        };

        let word_embeddings = ld.t2(c.vocab_size, h)?;
        let position_embeddings = ld.t2(c.max_position, h)?;
        let token_type_embeddings = ld.t2(c.type_vocab_size, h)?;
        let embed_norm = ld.norm(h)?;

        let mut layers = Vec::with_capacity(c.num_layers);
        for _ in 0..c.num_layers {
            layers.push(Layer {
                query: ld.dense(h, h)?,
                key: ld.dense(h, h)?,
                value: ld.dense(h, h)?,
                attn_out: ld.dense(h, h)?,
                attn_norm: ld.norm(h)?,
                ffn_in: ld.dense(h, i)?,
                ffn_out: ld.dense(i, h)?,
                ffn_norm: ld.norm(h)?,
            });
        }
        if !ld.reader.is_exhausted() {
            return Err(WeightError::InvalidConfig(
                "payload has unread tensors".to_string(),
            ));
        }

        Ok(Self {
            config: c,
            word_embeddings,
            position_embeddings,
            token_type_embeddings,
            embed_norm,
            layers,
        })
    }

    pub fn config(&self) -> &BertConfig {
        &self.config
    }

    /// `input_ids`/`attention_mask`: [batch, seq] → L2-normalised [batch, hidden].
    pub fn forward(
        &self,
        input_ids: Tensor<B, 2, Int>,
        attention_mask: Tensor<B, 2>,
    ) -> Tensor<B, 2> {
        let [batch, seq] = input_ids.dims();
        let h = self.config.hidden_size;
        let eps = self.config.layer_norm_eps;

        let words = self
            .word_embeddings
            .clone()
            .select(0, input_ids.reshape([batch * seq]))
            .reshape([batch, seq, h]);
        let positions = self
            .position_embeddings
            .clone()
            .slice([0..seq, 0..h])
            .unsqueeze::<3>();
        // Single-segment input: token_type_id is always 0.
        let token_type = self
            .token_type_embeddings
            .clone()
            .slice([0..1, 0..h])
            .unsqueeze::<3>();
        let mut hidden = layer_norm(words + positions + token_type, &self.embed_norm, eps);

        // Additive mask [batch, 1, 1, seq]: 0 for real tokens, very negative for padding.
        let mask_bias = (attention_mask.clone().neg() + 1.0)
            .mul_scalar(-1.0e9)
            .unsqueeze_dim::<3>(1)
            .unsqueeze_dim::<4>(1);

        for layer in &self.layers {
            hidden = self.layer_forward(layer, hidden, mask_bias.clone());
        }

        mean_pool_normalize(hidden, attention_mask)
    }

    fn layer_forward(
        &self,
        layer: &Layer<B>,
        hidden: Tensor<B, 3>,
        mask_bias: Tensor<B, 4>,
    ) -> Tensor<B, 3> {
        let [batch, seq, h] = hidden.dims();
        let heads = self.config.num_heads;
        let hd = self.config.head_dim();
        let eps = self.config.layer_norm_eps;

        let split = |t: Tensor<B, 3>| t.reshape([batch, seq, heads, hd]).swap_dims(1, 2);
        let q = split(dense(hidden.clone(), &layer.query));
        let k = split(dense(hidden.clone(), &layer.key));
        let v = split(dense(hidden.clone(), &layer.value));

        let scores = q.matmul(k.swap_dims(2, 3)).div_scalar((hd as f64).sqrt()) + mask_bias;
        let probs = burn::tensor::activation::softmax(scores, 3);
        let context = probs.matmul(v).swap_dims(1, 2).reshape([batch, seq, h]);

        let attended = layer_norm(
            dense(context, &layer.attn_out) + hidden,
            &layer.attn_norm,
            eps,
        );
        let inner = gelu_exact(dense(attended.clone(), &layer.ffn_in));
        layer_norm(
            dense(inner, &layer.ffn_out) + attended,
            &layer.ffn_norm,
            eps,
        )
    }
}

fn dense<B: Backend>(x: Tensor<B, 3>, d: &Dense<B>) -> Tensor<B, 3> {
    x.matmul(d.weight.clone().unsqueeze::<3>()) + d.bias.clone().unsqueeze::<3>()
}

fn layer_norm<B: Backend>(x: Tensor<B, 3>, n: &LayerNorm<B>, eps: f64) -> Tensor<B, 3> {
    let (var, mean) = x.clone().var_mean_bias(2);
    let normed = (x - mean).div(var.add_scalar(eps).sqrt());
    normed * n.gamma.clone().unsqueeze::<3>() + n.beta.clone().unsqueeze::<3>()
}

/// GELU as used by BERT: 0.5·x·(1 + erf(x/√2)).
fn gelu_exact<B: Backend>(x: Tensor<B, 3>) -> Tensor<B, 3> {
    let cdf = x
        .clone()
        .div_scalar(std::f64::consts::SQRT_2)
        .erf()
        .add_scalar(1.0)
        .mul_scalar(0.5);
    x * cdf
}

/// Attention-masked mean over the sequence, then L2 normalisation.
fn mean_pool_normalize<B: Backend>(hidden: Tensor<B, 3>, mask: Tensor<B, 2>) -> Tensor<B, 2> {
    let mask3: Tensor<B, 3> = mask.unsqueeze_dim(2);
    let summed: Tensor<B, 2> = (hidden * mask3.clone()).sum_dim(1).squeeze_dim(1);
    let counts: Tensor<B, 2> = mask3.sum_dim(1).squeeze_dim(1).clamp_min(1e-9);
    l2_normalize(summed / counts)
}

pub fn l2_normalize<B: Backend>(t: Tensor<B, 2>) -> Tensor<B, 2> {
    let norm = t.clone().powi_scalar(2).sum_dim(1).sqrt().clamp_min(1e-12);
    t / norm
}
