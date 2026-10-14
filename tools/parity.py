"""
parity.py — Compare the Rust engine against the Hugging Face reference.

Checks, for a fixed adversarial text set:
  1. token ids: Rust WordPiece  vs  transformers BertTokenizerFast (exact match)
  2. embeddings: Rust encoder (CPU backend, via target/release/clearscroll-embed)
                 vs  transformers BertModel + masked mean pooling + L2 norm (float32)

Usage:
    cargo build --release --no-default-features --features cli
    .venv/bin/python tools/parity.py [--model bert-tiny] [--write-fixtures]

--write-fixtures regenerates tests/fixtures/*.json, which the Rust test suite
uses so tokenizer parity is enforced even without Python installed.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "target" / "release" / "clearscroll-embed"
FIXTURES = REPO / "tests" / "fixtures"
MAX_LEN = 128

# Tolerances for float32 CPU inference vs PyTorch float32. Differences come
# only from summation order; anything beyond these indicates a real bug.
MAX_ABS_TOL = 1e-4
MIN_COSINE = 0.99999

TEXTS = [
    "",
    "   ",
    "Hello, World!",
    "Bitcoin and Ethereum prices surged after the ETF approval.",
    "The season finale reveals that the captain was the traitor all along.",
    "Café résumé naïve coöperate façade jalapeño",
    "İstanbul'da bugün hava çok güzel; Ağrı, Iğdır ve Şırnak'ta kar yağışı bekleniyor.",
    "ISTANBUL istanbul İSTANBUL ıı İİ",
    "Ünlü futbolcu transfer döneminde Galatasaray'a imza attı.",
    "Kripto paralar ve borsa haberleri: BIST 100 endeksi yükseldi.",
    "中文测试，日本語のテキスト、한국어 텍스트",
    "Emoji test 🚀🔥 and symbols ™ © ® € £ ¥ — “quotes” ‘single’ …",
    "Tabs\tand\nnewlines\r\nand nbsp and​zero-width",
    "Control\u0007chars\u0000and�replacement",
    "Ελληνικά κείμενο ΣΊΣΥΦΟΣ",
    "Русский текст: Ёлка и ЁЖИК",
    "مرحبا بالعالم",
    "supercalifragilisticexpialidocious antidisestablishmentarianism",
    "x" * 101,
    "y" * 100,
    "e-mail: someone@example.com, URL: https://example.com/a?b=c#d",
    "1234567890 3.14159 1,000,000 $100 50%",
    "SHOUTING ALL CAPS HEADLINE ABOUT THE ELECTION RESULTS",
    "word " * 300,
]


def run_rust(weights: Path, vocab: Path, texts: list[str]) -> dict:
    if not CLI.exists():
        sys.exit(f"{CLI} not found; run: cargo build --release --no-default-features --features cli")
    proc = subprocess.run(
        [str(CLI), "--weights", str(weights), "--vocab", str(vocab)],
        input=json.dumps({"texts": texts}),
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        sys.exit(f"clearscroll-embed failed: {proc.stderr}")
    return json.loads(proc.stdout)


def reference(model_dir: Path, vocab: Path, texts: list[str]):
    """HF reference: `tokenizers` BertWordPiece pipeline + transformers BertModel."""
    import torch
    from tokenizers import BertWordPieceTokenizer
    from transformers import AutoTokenizer, BertModel

    tok = BertWordPieceTokenizer(str(vocab), lowercase=True, clean_text=True,
                                 handle_chinese_chars=True, strip_accents=None)
    tok.enable_truncation(MAX_LEN)
    ids = [e.ids for e in tok.encode_batch(texts)]

    # Cross-check against the tokenizer transformers would load for this model.
    try:
        auto = AutoTokenizer.from_pretrained(str(model_dir))
    except ValueError as e:  # e.g. bert-tiny ships only vocab.txt
        print(f"reference self-check: AutoTokenizer unavailable for this repo ({str(e).splitlines()[0]})")
    else:
        auto_ids = [auto(t, truncation=True, max_length=MAX_LEN)["input_ids"] for t in texts]
        disagree = sum(a != b for a, b in zip(ids, auto_ids))
        print(f"reference self-check: tokenizers vs AutoTokenizer disagree on {disagree} texts")
        if disagree:
            sys.exit("reference tokenizers disagree; fix the reference before trusting parity")

    model = BertModel.from_pretrained(str(model_dir), add_pooling_layer=False).eval()
    seq = max(map(len, ids))
    input_ids = torch.tensor([i + [0] * (seq - len(i)) for i in ids])
    mask = torch.tensor([[1] * len(i) + [0] * (seq - len(i)) for i in ids])
    with torch.no_grad():
        hidden = model(input_ids=input_ids, attention_mask=mask,
                       token_type_ids=torch.zeros_like(input_ids)).last_hidden_state
        m = mask.unsqueeze(-1).float()
        pooled = (hidden * m).sum(1) / m.sum(1).clamp(min=1e-9)
        emb = torch.nn.functional.normalize(pooled, dim=1)
    return ids, emb.numpy()


def main() -> None:
    lock = json.loads((REPO / "tools" / "model_lock.json").read_text())
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=lock["default"], choices=sorted(lock["models"]))
    ap.add_argument("--write-fixtures", action="store_true")
    args = ap.parse_args()

    entry = lock["models"][args.model]
    art = REPO / "build" / "models" / args.model
    weights, vocab = art / "weights.bin", art / "vocab.txt"
    if not weights.exists():
        sys.exit(f"{weights} missing; run tools/prepare_model.py --model {args.model}")

    from huggingface_hub import snapshot_download

    model_dir = Path(snapshot_download(entry["repo"], revision=entry["revision"],
                                       allow_patterns=["*.json", "*.txt", "*.bin", "*.safetensors"]))

    rust = run_rust(weights, vocab, TEXTS)
    ref_ids, ref_emb = reference(model_dir, vocab, TEXTS)
    rust_emb = np.asarray(rust["embeddings"], dtype=np.float32)

    token_mismatches = [
        (t, r, e) for t, r, e in zip(TEXTS, rust["token_ids"], ref_ids) if r != e
    ]
    abs_diff = np.abs(rust_emb - ref_emb).max(axis=1)
    cosine = (rust_emb * ref_emb).sum(axis=1)

    print(f"model: {args.model} ({entry['repo']}@{entry['revision'][:12]})")
    print(f"texts: {len(TEXTS)}")
    print(f"token id mismatches: {len(token_mismatches)}")
    for t, r, e in token_mismatches:
        print(f"  {t[:50]!r}\n    rust={r[:20]}\n    ref ={e[:20]}")
    print(f"embedding max |Δ|: {abs_diff.max():.3e} (tolerance {MAX_ABS_TOL:.0e})")
    print(f"embedding min cosine(rust, ref): {cosine.min():.8f} (tolerance {MIN_COSINE})")

    ok = not token_mismatches and abs_diff.max() <= MAX_ABS_TOL and cosine.min() >= MIN_COSINE

    if args.write_fixtures:
        FIXTURES.mkdir(parents=True, exist_ok=True)
        (FIXTURES / "tokenizer_parity.json").write_text(
            json.dumps({"max_len": MAX_LEN, "cases": [{"text": t, "ids": i} for t, i in zip(TEXTS, ref_ids)]},
                       ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        subset = [0, 2, 3, 6, 10, 23]
        (FIXTURES / f"embedding_parity_{args.model}.json").write_text(
            json.dumps({
                "model": args.model,
                "weights_sha256": entry["weights_sha256"],
                "max_abs_tol": MAX_ABS_TOL,
                "cases": [{"text": TEXTS[i], "embedding": [round(float(x), 7) for x in ref_emb[i]]} for i in subset],
            }, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"fixtures written to {FIXTURES.relative_to(REPO)}")

    print("PARITY OK" if ok else "PARITY FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
