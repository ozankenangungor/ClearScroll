#![recursion_limit = "256"]

use js_sys::{Array, Float32Array};
use wasm_bindgen::prelude::*;

mod model;
mod state;
mod tokenizer;

/// Initialize the WebGPU backend and load the model.
/// Must be called once before any other functions.
#[wasm_bindgen]
pub async fn init() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    state::initialize()
        .await
        .map_err(|e| JsValue::from_str(&e))
}

/// Compute the sentence embedding for a single text.
/// Returns a Float32Array of length 128 (L2-normalized).
/// Use this to pre-compute the user's "block prompt" reference vector.
#[wasm_bindgen]
pub fn embed_text(text: String) -> Result<Float32Array, JsValue> {
    let embedder =
        state::get().ok_or_else(|| JsValue::from_str("Not initialized. Call init() first."))?;

    let results = embedder
        .embed(&[text])
        .map_err(|e| JsValue::from_str(&e))?;

    let embedding = &results[0];
    let out = Float32Array::new_with_length(embedding.len() as u32);
    out.copy_from(embedding);
    Ok(out)
}

/// Compare a batch of texts against a reference embedding.
/// Returns a JS Array of booleans — true if cosine similarity >= threshold.
///
/// - `reference_embedding`: Float32Array from a previous `embed_text()` call
/// - `texts`: array of strings to check
/// - `threshold`: similarity cutoff (e.g. 0.6)
#[wasm_bindgen]
pub fn compare_batch(
    reference_embedding: &Float32Array,
    texts: Vec<String>,
    threshold: f32,
) -> Result<Array, JsValue> {
    let embedder =
        state::get().ok_or_else(|| JsValue::from_str("Not initialized. Call init() first."))?;

    let ref_vec: Vec<f32> = reference_embedding.to_vec();

    let results = embedder
        .compare(&ref_vec, &texts, threshold)
        .map_err(|e| JsValue::from_str(&e))?;

    let out = Array::new_with_length(results.len() as u32);
    for (i, &flag) in results.iter().enumerate() {
        out.set(i as u32, JsValue::from_bool(flag));
    }
    Ok(out)
}
