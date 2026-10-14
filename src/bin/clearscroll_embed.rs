//! Native CLI around the production embedder (CPU backend).
//!
//! Reads one JSON document from stdin:  {"texts": ["...", ...]}
//! Writes one JSON document to stdout:  {"dim": N, "token_ids": [[...]], "embeddings": [[...]]}
//!
//! Used by tools/parity.py and tools/evaluate.py so that parity checks and
//! quality metrics exercise the same Rust code that ships in the extension.

use std::io::{Read, Write};
use std::time::Instant;

use burn::backend::NdArray;
use clearscroll_engine::embedder::Embedder;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Request {
    texts: Vec<String>,
}

#[derive(Serialize)]
struct Response {
    dim: usize,
    token_ids: Vec<Vec<u32>>,
    embeddings: Vec<Vec<f32>>,
    embed_ms: f64,
}

fn arg(name: &str) -> Option<String> {
    let mut args = std::env::args();
    while let Some(a) = args.next() {
        if a == name {
            return args.next();
        }
    }
    None
}

fn main() {
    if let Err(e) = run() {
        eprintln!("clearscroll-embed: {e}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let usage =
        "usage: clearscroll-embed --weights <weights.bin> --vocab <vocab.txt> < request.json";
    let weights_path = arg("--weights").ok_or(usage)?;
    let vocab_path = arg("--vocab").ok_or(usage)?;
    let weights = std::fs::read(&weights_path).map_err(|e| format!("{weights_path}: {e}"))?;
    let vocab = std::fs::read_to_string(&vocab_path).map_err(|e| format!("{vocab_path}: {e}"))?;

    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    let req: Request = serde_json::from_str(&input).map_err(|e| format!("bad request: {e}"))?;

    let embedder = Embedder::<NdArray>::new(&weights, &vocab, Default::default())?;
    let dim = embedder.dim();
    let token_ids = req.texts.iter().map(|t| embedder.tokenize(t)).collect();
    let start = Instant::now();
    let flat = embedder.embed_sync(&req.texts)?;
    let embed_ms = start.elapsed().as_secs_f64() * 1000.0;

    let resp = Response {
        dim,
        token_ids,
        embeddings: flat.chunks(dim).map(<[f32]>::to_vec).collect(),
        embed_ms,
    };
    let mut out = std::io::stdout().lock();
    serde_json::to_writer(&mut out, &resp).map_err(|e| e.to_string())?;
    out.write_all(b"\n").map_err(|e| e.to_string())
}
