use burn::nn::{Embedding, EmbeddingConfig, Linear, LinearConfig};
use burn::prelude::*;

#[derive(Config, Debug)]
pub struct TextClassifierConfig {
    pub vocab_size: usize,
    pub embedding_dim: usize,
    pub max_seq_len: usize,
    pub num_classes: usize,
}

impl TextClassifierConfig {
    pub fn placeholder() -> Self {
        Self::new(30522, 64, 128, 1)
    }
}

#[derive(Module, Debug)]
pub struct TextClassifier<B: Backend> {
    embedding: Embedding<B>,
    linear: Linear<B>,
    max_seq_len: usize,
}

impl TextClassifierConfig {
    pub fn init_model<B: Backend>(&self, device: &B::Device) -> TextClassifier<B> {
        TextClassifier {
            embedding: EmbeddingConfig::new(self.vocab_size, self.embedding_dim).init(device),
            linear: LinearConfig::new(self.embedding_dim, self.num_classes).init(device),
            max_seq_len: self.max_seq_len,
        }
    }
}

impl<B: Backend> TextClassifier<B> {
    /// Forward pass: token_ids [batch, seq_len] -> logits [batch, num_classes]
    pub fn forward(&self, token_ids: Tensor<B, 2, Int>) -> Tensor<B, 2> {
        // [batch, seq_len] -> [batch, seq_len, embedding_dim]
        let embedded = self.embedding.forward(token_ids);
        // Mean pooling over sequence dimension -> [batch, 1, embedding_dim] -> squeeze -> [batch, embedding_dim]
        let pooled: Tensor<B, 2> = embedded.mean_dim(1).squeeze_dim(1);
        // [batch, embedding_dim] -> [batch, num_classes]
        self.linear.forward(pooled)
    }

    /// Run forward pass, apply sigmoid, threshold at 0.5 -> Vec<bool>
    pub fn predict(&self, token_ids: Tensor<B, 2, Int>) -> Vec<bool> {
        let logits = self.forward(token_ids);
        let probs = burn::tensor::activation::sigmoid(logits);
        let data = probs.to_data();
        data.iter::<f32>().map(|v| v > 0.5).collect()
    }
}
