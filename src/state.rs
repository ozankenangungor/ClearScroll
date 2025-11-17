use std::cell::RefCell;
use std::rc::Rc;

use burn::prelude::*;

use crate::model::{BertTinyConfig, TextEmbedder, cosine_similarity_batch};
use crate::tokenizer;

// --- Backend selection via features ---

#[cfg(feature = "wgpu")]
mod backend {
    pub type SelectedBackend = burn::backend::Wgpu;

    pub fn default_device() -> burn::backend::wgpu::WgpuDevice {
        burn::backend::wgpu::WgpuDevice::default()
    }
}

#[cfg(all(feature = "ndarray", not(feature = "wgpu")))]
mod backend {
    pub type SelectedBackend = burn::backend::NdArray;

    pub fn default_device() -> burn::backend::ndarray::NdArrayDevice {
        burn::backend::ndarray::NdArrayDevice::default()
    }
}

type B = backend::SelectedBackend;
type Device = <B as Backend>::Device;

/// Holds the initialized embedder model and device, cached for reuse.
pub struct Embedder {
    model: TextEmbedder<B>,
    config: BertTinyConfig,
    device: Device,
}

impl Embedder {
    /// Embed a batch of texts → Vec<Vec<f32>> (each inner vec is a 128-dim L2-normalized vector).
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let (token_ids, attention_masks) =
            tokenizer::tokenize_batch(texts, self.config.max_seq_len);
        let batch_size = token_ids.len();
        let seq_len = self.config.max_seq_len;

        let ids_tensor = self.make_int_tensor(&token_ids, batch_size, seq_len);
        let mask_tensor = self.make_mask_tensor(&attention_masks, batch_size, seq_len);

        let embeddings = self.model.forward(ids_tensor, mask_tensor); // [batch, hidden]
        let data = embeddings.to_data();
        let flat: Vec<f32> = data.iter::<f32>().collect();

        Ok(flat
            .chunks(self.config.hidden_size)
            .map(|chunk| chunk.to_vec())
            .collect())
    }

    /// Compare a batch of texts against a reference embedding.
    /// Returns Vec<bool> — true if cosine similarity >= threshold.
    pub fn compare(
        &self,
        reference: &[f32],
        texts: &[String],
        threshold: f32,
    ) -> Result<Vec<bool>, String> {
        let (token_ids, attention_masks) =
            tokenizer::tokenize_batch(texts, self.config.max_seq_len);
        let batch_size = token_ids.len();
        let seq_len = self.config.max_seq_len;

        let ids_tensor = self.make_int_tensor(&token_ids, batch_size, seq_len);
        let mask_tensor = self.make_mask_tensor(&attention_masks, batch_size, seq_len);

        // Embed the batch
        let batch_emb = self.model.forward(ids_tensor, mask_tensor); // [N, hidden]

        // Reference embedding → [1, hidden], broadcast to [N, hidden]
        let ref_tensor = Tensor::<B, 2>::from_data(
            TensorData::new(reference.to_vec(), [1, self.config.hidden_size]),
            &self.device,
        )
        .expand([batch_size, self.config.hidden_size]);

        // Cosine similarity (both are L2-normalized)
        let sims = cosine_similarity_batch::<B>(ref_tensor, batch_emb); // [N]
        let sim_data = sims.to_data();

        Ok(sim_data.iter::<f32>().map(|s| s >= threshold).collect())
    }

    fn make_int_tensor(
        &self,
        token_ids: &[Vec<usize>],
        batch_size: usize,
        seq_len: usize,
    ) -> Tensor<B, 2, Int> {
        let flat_ids: Vec<i32> = token_ids
            .iter()
            .flat_map(|row| row.iter().map(|&v| v as i32))
            .collect();
        Tensor::<B, 1, Int>::from_data(
            TensorData::new(flat_ids, [batch_size * seq_len]),
            &self.device,
        )
        .reshape([batch_size, seq_len])
    }

    fn make_mask_tensor(
        &self,
        masks: &[Vec<i32>],
        batch_size: usize,
        seq_len: usize,
    ) -> Tensor<B, 2, Int> {
        let flat_mask: Vec<i32> = masks.iter().flatten().copied().collect();
        Tensor::<B, 1, Int>::from_data(
            TensorData::new(flat_mask, [batch_size * seq_len]),
            &self.device,
        )
        .reshape([batch_size, seq_len])
    }
}

// WASM is single-threaded — use thread_local + RefCell instead of OnceLock.
thread_local! {
    static EMBEDDER: RefCell<Option<Rc<Embedder>>> = const { RefCell::new(None) };
}

/// Initialize the backend device and model. Call once from JS.
pub async fn initialize() -> Result<(), String> {
    let already_init = EMBEDDER.with(|c| c.borrow().is_some());
    if already_init {
        return Ok(());
    }

    let device = backend::default_device();
    let config = BertTinyConfig::default_config();

    // Embed pretrained weights at compile time (no filesystem in WASM).
    const WEIGHTS: &[u8] = include_bytes!("../model/weights.bin");
    let mut model = config.init_model::<B>(&device);
    crate::model::load_pretrained_weights(&mut model, WEIGHTS, &device);

    let embedder = Rc::new(Embedder {
        model,
        config,
        device,
    });

    EMBEDDER.with(|c| {
        *c.borrow_mut() = Some(embedder);
    });

    Ok(())
}

/// Get a reference to the cached embedder, or None if not yet initialized.
pub fn get() -> Option<Rc<Embedder>> {
    EMBEDDER.with(|c| c.borrow().clone())
}
