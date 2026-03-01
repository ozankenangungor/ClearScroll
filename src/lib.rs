#![recursion_limit = "256"]

use js_sys::Array;
use wasm_bindgen::prelude::*;

mod model;
mod state;
mod tokenizer;

/// Initialize the WebGPU backend and load the model.
/// Must be called once before any calls to `classify_batch`.
#[wasm_bindgen]
pub async fn init() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    state::initialize()
        .await
        .map_err(|e| JsValue::from_str(&e))
}

/// Classify a batch of text strings.
/// Returns a JS `Array` of booleans — one per input string.
#[wasm_bindgen]
pub fn classify_batch(texts: Vec<String>) -> Result<Array, JsValue> {
    let classifier =
        state::get().ok_or_else(|| JsValue::from_str("Not initialized. Call init() first."))?;

    let results = classifier
        .classify(&texts)
        .map_err(|e| JsValue::from_str(&e))?;

    let out = Array::new_with_length(results.len() as u32);
    for (i, &flag) in results.iter().enumerate() {
        out.set(i as u32, JsValue::from_bool(flag));
    }
    Ok(out)
}
