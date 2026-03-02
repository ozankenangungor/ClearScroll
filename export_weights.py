"""
export_weights.py — Export prajjwal1/bert-tiny encoder weights as raw f32 bytes.

Produces model/weights.bin: a headerless concatenation of f32 little-endian
tensors in the exact order expected by src/model.rs::load_pretrained_weights().

Key transformations:
  - Linear weights are TRANSPOSED (PyTorch [out, in] → Burn [in, out])
  - Position embeddings are SLICED from [512, 128] to [128, 128]
  - NO classification head — this model produces sentence embeddings only

Usage:
    source .venv/bin/activate
    python export_weights.py
"""

from transformers import BertModel
import torch
import os

OUT_DIR = "model"
MAX_SEQ_LEN = 128
HIDDEN = 128
NUM_LAYERS = 2
INTERMEDIATE = 512
VOCAB_SIZE = 30522


def write_tensor(f, tensor, name=""):
    """Write tensor as raw f32 little-endian bytes, print shape for verification."""
    data = tensor.detach().float().cpu().contiguous().numpy()
    raw = data.tobytes()
    print(f"  {name:55s} shape={str(list(data.shape)):20s} {len(raw):>10,} bytes")
    f.write(raw)
    return len(raw)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    print("[1/2] Loading prajjwal1/bert-tiny ...")
    model = BertModel.from_pretrained("prajjwal1/bert-tiny")
    sd = model.state_dict()

    print(f"\n  state_dict has {len(sd)} keys:")
    for k, v in sd.items():
        print(f"    {k:60s} {list(v.shape)}")

    print(f"\n[2/2] Writing encoder weights to {OUT_DIR}/weights.bin ...")
    total = 0

    with open(os.path.join(OUT_DIR, "weights.bin"), "wb") as f:
        # ── Embeddings ──────────────────────────────────────────────
        print("\n  === Embeddings ===")
        total += write_tensor(
            f, sd["embeddings.word_embeddings.weight"],
            "embeddings.word_embeddings.weight"
        )
        total += write_tensor(
            f, sd["embeddings.position_embeddings.weight"][:MAX_SEQ_LEN],
            f"embeddings.position_embeddings.weight[:{MAX_SEQ_LEN}]"
        )
        total += write_tensor(
            f, sd["embeddings.token_type_embeddings.weight"],
            "embeddings.token_type_embeddings.weight"
        )
        total += write_tensor(
            f, sd["embeddings.LayerNorm.weight"],
            "embeddings.LayerNorm.weight (gamma)"
        )
        total += write_tensor(
            f, sd["embeddings.LayerNorm.bias"],
            "embeddings.LayerNorm.bias (beta)"
        )

        # ── Encoder Layers ──────────────────────────────────────────
        for i in range(NUM_LAYERS):
            pfx = f"encoder.layer.{i}"
            print(f"\n  === Layer {i} — Attention ===")

            total += write_tensor(f, sd[f"{pfx}.attention.self.query.weight"].t(),
                                  f"L{i}.attention.query.weight (transposed)")
            total += write_tensor(f, sd[f"{pfx}.attention.self.query.bias"],
                                  f"L{i}.attention.query.bias")
            total += write_tensor(f, sd[f"{pfx}.attention.self.key.weight"].t(),
                                  f"L{i}.attention.key.weight (transposed)")
            total += write_tensor(f, sd[f"{pfx}.attention.self.key.bias"],
                                  f"L{i}.attention.key.bias")
            total += write_tensor(f, sd[f"{pfx}.attention.self.value.weight"].t(),
                                  f"L{i}.attention.value.weight (transposed)")
            total += write_tensor(f, sd[f"{pfx}.attention.self.value.bias"],
                                  f"L{i}.attention.value.bias")
            total += write_tensor(f, sd[f"{pfx}.attention.output.dense.weight"].t(),
                                  f"L{i}.attention.output.weight (transposed)")
            total += write_tensor(f, sd[f"{pfx}.attention.output.dense.bias"],
                                  f"L{i}.attention.output.bias")
            total += write_tensor(f, sd[f"{pfx}.attention.output.LayerNorm.weight"],
                                  f"L{i}.attention.LayerNorm.weight (gamma)")
            total += write_tensor(f, sd[f"{pfx}.attention.output.LayerNorm.bias"],
                                  f"L{i}.attention.LayerNorm.bias (beta)")

            print(f"\n  === Layer {i} — FFN ===")

            total += write_tensor(f, sd[f"{pfx}.intermediate.dense.weight"].t(),
                                  f"L{i}.ffn.intermediate.weight (transposed)")
            total += write_tensor(f, sd[f"{pfx}.intermediate.dense.bias"],
                                  f"L{i}.ffn.intermediate.bias")
            total += write_tensor(f, sd[f"{pfx}.output.dense.weight"].t(),
                                  f"L{i}.ffn.output.weight (transposed)")
            total += write_tensor(f, sd[f"{pfx}.output.dense.bias"],
                                  f"L{i}.ffn.output.bias")
            total += write_tensor(f, sd[f"{pfx}.output.LayerNorm.weight"],
                                  f"L{i}.ffn.LayerNorm.weight (gamma)")
            total += write_tensor(f, sd[f"{pfx}.output.LayerNorm.bias"],
                                  f"L{i}.ffn.LayerNorm.bias (beta)")

    size_mb = total / (1024 * 1024)
    print(f"\nDone! {OUT_DIR}/weights.bin: {total:,} bytes ({size_mb:.2f} MB)")

    # Sanity check: expected param count (encoder only, no classifier)
    expected_params = (
        VOCAB_SIZE * HIDDEN          # word_embeddings
        + MAX_SEQ_LEN * HIDDEN       # position_embeddings (sliced)
        + 2 * HIDDEN                 # token_type_embeddings
        + HIDDEN + HIDDEN            # embedding LayerNorm
        + NUM_LAYERS * (
            4 * HIDDEN * HIDDEN      # Q, K, V, O weights
            + 4 * HIDDEN             # Q, K, V, O biases
            + HIDDEN + HIDDEN        # attention LayerNorm
            + HIDDEN * INTERMEDIATE  # FFN intermediate weight
            + INTERMEDIATE           # FFN intermediate bias
            + INTERMEDIATE * HIDDEN  # FFN output weight
            + HIDDEN                 # FFN output bias
            + HIDDEN + HIDDEN        # FFN LayerNorm
        )
    )
    expected_bytes = expected_params * 4
    assert total == expected_bytes, (
        f"Size mismatch! Got {total} bytes but expected {expected_bytes} "
        f"({expected_params} params x 4 bytes)"
    )
    print(f"Sanity check passed: {expected_params:,} params x 4 = {expected_bytes:,} bytes")


if __name__ == "__main__":
    main()
