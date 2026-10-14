//! Optional GPU verification: runs the encoder on the native wgpu backend
//! (Vulkan/Metal/DX12 — whatever wgpu picks on this machine) and compares it
//! with the PyTorch reference fixture.
//!
//!   cargo test --release --no-default-features --features webgpu,cpu --test gpu_parity -- --ignored --nocapture
//!
//! Ignored by default because CI runners have no GPU.

#![cfg(feature = "webgpu")]

use std::path::PathBuf;

use burn::backend::wgpu::{Wgpu, WgpuDevice};
use clearscroll_engine::embedder::Embedder;

#[test]
#[ignore = "needs a GPU and prepared model artifacts"]
fn wgpu_embeddings_match_reference() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let model = std::env::var("CLEARSCROLL_MODEL").unwrap_or_else(|_| "minilm-l6".into());
    let dir = repo.join("build/models").join(&model);
    let weights = std::fs::read(dir.join("weights.bin")).expect("prepare the model first");
    let vocab = std::fs::read_to_string(dir.join("vocab.txt")).unwrap();
    let fx: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            repo.join(format!("tests/fixtures/embedding_parity_{model}.json")),
        )
        .unwrap(),
    )
    .unwrap();
    let cases = fx["cases"].as_array().unwrap();
    let texts: Vec<String> = cases
        .iter()
        .map(|c| c["text"].as_str().unwrap().to_string())
        .collect();

    let embedder = Embedder::<Wgpu>::new(&weights, &vocab, WgpuDevice::default()).unwrap();
    let flat = embedder.embed_sync(&texts).unwrap();
    let dim = embedder.dim();
    let mut worst = 0.0f32;
    for (i, case) in cases.iter().enumerate() {
        for (j, v) in case["embedding"].as_array().unwrap().iter().enumerate() {
            let d = (flat[i * dim + j] - v.as_f64().unwrap() as f32).abs();
            assert!(!d.is_nan(), "NaN in GPU output for text {i}");
            worst = worst.max(d);
        }
    }
    println!("wgpu vs reference: max |Δ| = {worst:e}");
    assert!(
        worst < 1e-3,
        "GPU output deviates from reference by {worst}"
    );
}

/// Sequential batches with changing batch size and sequence length must all
/// match the CPU backend (guards against kernel-cache/fusion shape bugs).
#[test]
#[ignore = "needs a GPU and prepared model artifacts"]
fn wgpu_matches_cpu_across_changing_shapes() {
    use burn::backend::NdArray;
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let model = std::env::var("CLEARSCROLL_MODEL").unwrap_or_else(|_| "minilm-l6".into());
    let dir = repo.join("build/models").join(&model);
    let weights = std::fs::read(dir.join("weights.bin")).expect("prepare the model first");
    let vocab = std::fs::read_to_string(dir.join("vocab.txt")).unwrap();
    let gpu = Embedder::<Wgpu>::new(&weights, &vocab, WgpuDevice::default()).unwrap();
    let cpu = Embedder::<NdArray>::new(&weights, &vocab, Default::default()).unwrap();
    let pool = [
        "cryptocurrency",
        "Bitcoin and Ethereum prices surged after the ETF approval news this week.",
        "The local bakery opened a new branch selling sourdough bread and pastries.",
        "Solana validators reported another outage, and the token fell eight percent overnight.",
        "short",
        "A considerably longer sentence that keeps going to produce many more word pieces than the others in this batch, \
         so that the padded sequence length changes between calls.",
    ];
    let dim = gpu.dim();
    for (round, n) in [2usize, 4, 1, 6, 3, 5].into_iter().enumerate() {
        let texts: Vec<String> = (0..n)
            .map(|i| pool[(i + round) % pool.len()].to_string())
            .collect();
        let g = gpu.embed_sync(&texts).unwrap();
        let c = cpu.embed_sync(&texts).unwrap();
        let worst = g
            .iter()
            .zip(&c)
            .map(|(a, b)| (a - b).abs())
            .fold(
                0.0f32,
                |m, d| if d.is_nan() { f32::INFINITY } else { m.max(d) },
            );
        println!("round {round}: batch {n}, max |Δ| gpu vs cpu = {worst:e}");
        assert!(worst < 1e-3, "round {round}: GPU deviates by {worst}");
        assert_eq!(g.len(), n * dim);
    }
}
