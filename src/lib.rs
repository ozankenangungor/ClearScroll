//! ClearScroll inference engine: a BERT-family sentence encoder on Burn,
//! compiled to WebAssembly for the extension and natively for tests/evaluation.

#![recursion_limit = "256"]

pub mod embedder;
pub mod model;
pub mod tokenizer;
pub mod weights;

#[cfg(target_arch = "wasm32")]
mod wasm;
