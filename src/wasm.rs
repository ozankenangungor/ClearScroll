//! wasm-bindgen boundary. JS owns artifact loading (fetching weights and
//! vocab from the extension package) and backend selection; Rust owns all
//! numerics.
//!
//! Exactly one engine lives per WebAssembly instance (one per worker).

use std::cell::RefCell;
use std::rc::Rc;

use js_sys::Float32Array;
use wasm_bindgen::prelude::*;

use crate::embedder::{Embedder, GPU_CHUNK};

enum Engine {
    #[cfg(feature = "webgpu")]
    Gpu(Embedder<burn::backend::Wgpu>),
    #[cfg(feature = "cpu")]
    Cpu(Embedder<burn::backend::NdArray>),
}

impl Engine {
    fn dim(&self) -> usize {
        match self {
            #[cfg(feature = "webgpu")]
            Self::Gpu(e) => e.dim(),
            #[cfg(feature = "cpu")]
            Self::Cpu(e) => e.dim(),
        }
    }

    async fn embed(&self, texts: &[String]) -> Result<Vec<f32>, String> {
        match self {
            #[cfg(feature = "webgpu")]
            Self::Gpu(e) => e.embed(texts).await,
            #[cfg(feature = "cpu")]
            Self::Cpu(e) => e.embed(texts).await,
        }
    }
}

thread_local! {
    static ENGINE: RefCell<Option<Rc<Engine>>> = const { RefCell::new(None) };
}

fn current() -> Result<Rc<Engine>, JsValue> {
    ENGINE
        .with(|c| c.borrow().clone())
        .ok_or_else(|| JsValue::from_str("engine not initialised"))
}

/// Load the model on the requested backend (`"webgpu"` or `"cpu"`).
///
/// The caller must have verified that a WebGPU adapter exists before asking
/// for `"webgpu"`: the wgpu runtime aborts (panics) when none is available,
/// which leaves this instance unusable.
#[wasm_bindgen]
pub async fn init_engine(weights: Vec<u8>, vocab: String, backend: String) -> Result<u32, JsValue> {
    console_error_panic_hook::set_once();
    if ENGINE.with(|c| c.borrow().is_some()) {
        return Err(JsValue::from_str("engine already initialised"));
    }
    let engine = match backend.as_str() {
        #[cfg(feature = "webgpu")]
        "webgpu" => {
            use burn::backend::wgpu::{
                graphics::WebGpu, init_setup_async, RuntimeOptions, WgpuDevice,
            };
            let device = WgpuDevice::DefaultDevice;
            init_setup_async::<WebGpu>(&device, RuntimeOptions::default()).await;
            Engine::Gpu(
                Embedder::new(&weights, &vocab, device)
                    .map_err(|e| JsValue::from_str(&e))?
                    .with_chunk_size(GPU_CHUNK),
            )
        }
        #[cfg(feature = "cpu")]
        "cpu" => Engine::Cpu(
            Embedder::new(&weights, &vocab, Default::default())
                .map_err(|e| JsValue::from_str(&e))?,
        ),
        other => return Err(JsValue::from_str(&format!("unsupported backend {other:?}"))),
    };
    let dim = engine.dim() as u32;
    ENGINE.with(|c| *c.borrow_mut() = Some(Rc::new(engine)));
    Ok(dim)
}

/// Embed `texts`; returns a flat row-major Float32Array of `texts.len() × dim`
/// L2-normalised vectors.
#[wasm_bindgen]
pub async fn embed_batch(texts: Vec<String>) -> Result<Float32Array, JsValue> {
    let engine = current()?;
    let flat = engine
        .embed(&texts)
        .await
        .map_err(|e| JsValue::from_str(&e))?;
    Ok(Float32Array::from(flat.as_slice()))
}
