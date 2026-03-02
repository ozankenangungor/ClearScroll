"""
export_model.py — Download bert-tiny, add classification head, export to ONNX.

Usage:
    pip install transformers torch onnx onnxscript huggingface-hub
    python export_model.py

Output:
    model/model.onnx  — ONNX model (opset 14)
    model/vocab.txt   — BERT vocabulary (30522 tokens)
"""

from transformers import BertForSequenceClassification, BertConfig
from huggingface_hub import hf_hub_download
import torch
import os

OUT_DIR = "model"
MAX_SEQ_LEN = 128


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # ── 1. Download vocab.txt ────────────────────────────────────────────
    print("[1/3] Downloading BERT vocab.txt...")
    vocab_path = hf_hub_download(
        repo_id="google-bert/bert-base-uncased",
        filename="vocab.txt",
        local_dir=OUT_DIR,
    )
    # hf_hub_download may place it in a subdir; ensure it's at model/vocab.txt
    target = os.path.join(OUT_DIR, "vocab.txt")
    if os.path.abspath(vocab_path) != os.path.abspath(target):
        import shutil
        shutil.move(vocab_path, target)
    vocab_count = sum(1 for _ in open(target))
    print(f"    vocab.txt: {vocab_count} tokens")

    # ── 2. Load bert-tiny with classification head ───────────────────────
    print("[2/3] Loading bert-tiny with classification head...")
    config = BertConfig(
        vocab_size=30522,
        hidden_size=128,
        num_hidden_layers=2,
        num_attention_heads=2,
        intermediate_size=512,
        num_labels=1,
    )

    try:
        model = BertForSequenceClassification.from_pretrained(
            "prajjwal1/bert-tiny",
            config=config,
            ignore_mismatched_sizes=True,
        )
        print("    Loaded pretrained encoder weights (classifier head is random)")
    except Exception as e:
        print(f"    Pretrained load failed ({e}), using random init")
        model = BertForSequenceClassification(config)

    model.eval()

    # ── 3. Export to ONNX ────────────────────────────────────────────────
    print("[3/3] Exporting ONNX (opset 14)...")
    dummy_input_ids = torch.zeros(1, MAX_SEQ_LEN, dtype=torch.long)
    dummy_attention_mask = torch.ones(1, MAX_SEQ_LEN, dtype=torch.long)

    onnx_path = os.path.join(OUT_DIR, "model.onnx")

    torch.onnx.export(
        model,
        (dummy_input_ids, dummy_attention_mask),
        onnx_path,
        opset_version=14,
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq_len"},
            "attention_mask": {0: "batch", 1: "seq_len"},
            "logits": {0: "batch"},
        },
        dynamo=False,
    )

    onnx_size = os.path.getsize(onnx_path) / (1024 * 1024)
    print(f"    model.onnx: {onnx_size:.2f} MB")

    # Clean up intermediate files
    for f in os.listdir(OUT_DIR):
        if f.startswith("model_fp32") or f == "tokenizer.model":
            os.remove(os.path.join(OUT_DIR, f))

    print(f"\nDone! Files in {OUT_DIR}/:")
    for f in sorted(os.listdir(OUT_DIR)):
        size = os.path.getsize(os.path.join(OUT_DIR, f))
        print(f"    {f:30s} {size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
