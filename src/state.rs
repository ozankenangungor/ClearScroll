use std::cell::RefCell;
use std::rc::Rc;

use burn::prelude::*;

use crate::model::{TextClassifier, TextClassifierConfig};
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

/// Holds the initialized model and device, cached for reuse.
pub struct Classifier {
    model: TextClassifier<B>,
    config: TextClassifierConfig,
    device: Device,
}

impl Classifier {
    /// Run batched classification. Takes raw texts, returns Vec<bool>.
    pub fn classify(&self, texts: &[String]) -> Result<Vec<bool>, String> {
        let token_ids = tokenizer::tokenize_batch(texts, self.config.max_seq_len);
        let batch_size = token_ids.len();
        let seq_len = self.config.max_seq_len;

        // Flatten to 1D for tensor construction, then reshape to [batch, seq_len]
        let flat: Vec<i32> = token_ids
            .into_iter()
            .flat_map(|row| row.into_iter().map(|v| v as i32))
            .collect();

        let tensor = Tensor::<B, 1, Int>::from_data(
            TensorData::new(flat, [batch_size * seq_len]),
            &self.device,
        )
        .reshape([batch_size, seq_len]);

        Ok(self.model.predict(tensor))
    }
}

// WASM is single-threaded — use thread_local + RefCell instead of OnceLock.
thread_local! {
    static CLASSIFIER: RefCell<Option<Rc<Classifier>>> = const { RefCell::new(None) };
}

/// Initialize the backend device and model. Call once from JS.
pub async fn initialize() -> Result<(), String> {
    let already_init = CLASSIFIER.with(|c| c.borrow().is_some());
    if already_init {
        return Ok(());
    }

    let device = backend::default_device();
    let config = TextClassifierConfig::placeholder();
    let model = config.init_model::<B>(&device);

    let classifier = Rc::new(Classifier {
        model,
        config,
        device,
    });

    CLASSIFIER.with(|c| {
        *c.borrow_mut() = Some(classifier);
    });

    Ok(())
}

/// Get a reference to the cached classifier, or None if not yet initialized.
pub fn get() -> Option<Rc<Classifier>> {
    CLASSIFIER.with(|c| c.borrow().clone())
}
