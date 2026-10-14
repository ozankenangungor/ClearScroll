"""
prepare_model.py — Download a pinned BERT-family encoder and export it as a
ClearScroll weight file (CSWT format) that src/model.rs can load.

Every upstream file is pinned by Hugging Face revision AND sha256 (see
tools/model_lock.json). The exported weights.bin is deterministic, so its
sha256 is pinned too. Any mismatch is a hard failure: we never fall back to
randomly initialised weights.

Usage:
    .venv/bin/python tools/prepare_model.py                 # default model
    .venv/bin/python tools/prepare_model.py --model minilm-l6 --out build/models/minilm-l6
    .venv/bin/python tools/prepare_model.py --verify-only   # check existing artifacts

CSWT layout (all little-endian):
    magic        4 bytes  b"CSWT"
    version      u32      1
    vocab_size   u32
    hidden_size  u32
    num_layers   u32
    num_heads    u32
    intermediate u32
    max_pos      u32      position embeddings exported (sliced)
    type_vocab   u32
    ln_eps       f32
    dtype        u32      0 = f32
    payload      f32[]    tensors in the order of TENSOR_ORDER below;
                          linear weights transposed to [in, out]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = REPO_ROOT / "tools" / "model_lock.json"
MAGIC = b"CSWT"
FORMAT_VERSION = 1
MAX_SEQ_LEN = 128
DTYPE_F32 = 0

# Embedded in model.json as reference outputs. The extension embeds these at
# startup on the chosen backend and rejects the backend if the results differ
# (catches broken GPU drivers/emulators that return NaN or wrong values).
SELFTEST_TEXTS = [
    "ClearScroll engine self-test: the quick brown fox jumps over the lazy dog.",
    "Bitcoin prices surged after the ETF approval.",
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fail(msg: str) -> None:
    print(f"\nERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def load_lock() -> dict:
    with open(LOCK_PATH, encoding="utf-8") as f:
        return json.load(f)


def download_and_verify(entry: dict, update_lock: bool) -> dict[str, Path]:
    from huggingface_hub import hf_hub_download

    paths: dict[str, Path] = {}
    for name, expected in entry["files"].items():
        try:
            p = Path(hf_hub_download(entry["repo"], name, revision=entry["revision"]))
        except Exception as e:  # network, 404, rate limit, ...
            fail(f"download of {entry['repo']}@{entry['revision']}/{name} failed: {e}")
        actual = sha256_file(p)
        if update_lock:
            entry["files"][name] = actual
        elif actual != expected:
            fail(
                f"sha256 mismatch for {name}\n  expected {expected}\n  actual   {actual}\n"
                "The upstream file changed or the download is corrupt."
            )
        print(f"  ok  {name:24s} sha256={actual[:16]}…")
        paths[name] = p
    return paths


def load_state_dict(paths: dict[str, Path], cfg: dict):
    """Load the encoder via transformers and refuse partially-initialised models."""
    import torch
    from transformers import BertConfig, BertModel

    config = BertConfig.from_json_file(str(paths["config.json"]))
    model_dir = paths["config.json"].parent
    model, info = BertModel.from_pretrained(
        str(model_dir), config=config, output_loading_info=True, add_pooling_layer=False
    )
    missing = [k for k in info.get("missing_keys", []) if "pooler" not in k]
    if missing:
        fail(f"pretrained checkpoint is missing encoder tensors (would be random): {missing}")
    if info.get("mismatched_keys"):
        fail(f"pretrained checkpoint has mismatched tensor shapes: {info['mismatched_keys']}")
    model.eval()

    for key, want in (
        ("vocab_size", cfg["vocab_size"]),
        ("hidden_size", cfg["hidden_size"]),
        ("num_hidden_layers", cfg["num_layers"]),
        ("num_attention_heads", cfg["num_heads"]),
        ("intermediate_size", cfg["intermediate_size"]),
    ):
        got = getattr(config, key)
        if got != want:
            fail(f"config.{key} = {got}, lock file expects {want}")
    if config.hidden_act != "gelu":
        fail(f"unsupported activation {config.hidden_act!r}; src/model.rs implements exact GELU")
    if getattr(config, "position_embedding_type", "absolute") != "absolute":
        fail("only absolute position embeddings are supported")

    with torch.no_grad():
        return {k: v.detach().float().cpu().contiguous() for k, v in model.state_dict().items()}, config, model


def reference_embeddings(model, vocab_path: Path, texts: list[str]) -> list[list[float]]:
    """Masked mean pooling + L2 norm with the HF reference tokenizer and model."""
    import torch
    from tokenizers import BertWordPieceTokenizer

    tok = BertWordPieceTokenizer(str(vocab_path), lowercase=True)
    tok.enable_truncation(MAX_SEQ_LEN)
    out = []
    with torch.no_grad():
        for t in texts:
            ids = torch.tensor([tok.encode(t).ids])
            hidden = model(input_ids=ids, attention_mask=torch.ones_like(ids),
                           token_type_ids=torch.zeros_like(ids)).last_hidden_state
            emb = torch.nn.functional.normalize(hidden.mean(1), dim=1)[0]
            out.append([round(float(x), 6) for x in emb])
    return out


def tensor_order(num_layers: int) -> list[tuple[str, bool]]:
    """(state_dict key, transpose?) in the exact order src/model.rs consumes."""
    order = [
        ("embeddings.word_embeddings.weight", False),
        ("embeddings.position_embeddings.weight", False),
        ("embeddings.token_type_embeddings.weight", False),
        ("embeddings.LayerNorm.weight", False),
        ("embeddings.LayerNorm.bias", False),
    ]
    for i in range(num_layers):
        p = f"encoder.layer.{i}"
        order += [
            (f"{p}.attention.self.query.weight", True),
            (f"{p}.attention.self.query.bias", False),
            (f"{p}.attention.self.key.weight", True),
            (f"{p}.attention.self.key.bias", False),
            (f"{p}.attention.self.value.weight", True),
            (f"{p}.attention.self.value.bias", False),
            (f"{p}.attention.output.dense.weight", True),
            (f"{p}.attention.output.dense.bias", False),
            (f"{p}.attention.output.LayerNorm.weight", False),
            (f"{p}.attention.output.LayerNorm.bias", False),
            (f"{p}.intermediate.dense.weight", True),
            (f"{p}.intermediate.dense.bias", False),
            (f"{p}.output.dense.weight", True),
            (f"{p}.output.dense.bias", False),
            (f"{p}.output.LayerNorm.weight", False),
            (f"{p}.output.LayerNorm.bias", False),
        ]
    return order


def export(sd: dict, config, out_path: Path) -> int:
    import numpy as np

    h, inter, layers = config.hidden_size, config.intermediate_size, config.num_hidden_layers
    eps = float(getattr(config, "layer_norm_eps", 1e-12))
    header = MAGIC + struct.pack(
        "<8If I",
        FORMAT_VERSION,
        config.vocab_size,
        h,
        layers,
        config.num_attention_heads,
        inter,
        MAX_SEQ_LEN,
        config.type_vocab_size,
        eps,
        DTYPE_F32,
    )

    expected_shapes = {
        "embeddings.word_embeddings.weight": (config.vocab_size, h),
        "embeddings.position_embeddings.weight": (MAX_SEQ_LEN, h),
        "embeddings.token_type_embeddings.weight": (config.type_vocab_size, h),
    }

    tmp = out_path.with_suffix(".tmp")
    total = 0
    with open(tmp, "wb") as f:
        f.write(header)
        for key, transpose in tensor_order(layers):
            if key not in sd:
                fail(f"state_dict is missing {key}")
            t = sd[key]
            if key == "embeddings.position_embeddings.weight":
                t = t[:MAX_SEQ_LEN]
            if transpose:
                t = t.t().contiguous()
            arr = t.numpy().astype("<f4", copy=False)
            if not np.isfinite(arr).all():
                fail(f"{key} contains NaN/Inf")
            want = expected_shapes.get(key)
            if want and tuple(arr.shape) != want:
                fail(f"{key} has shape {arr.shape}, expected {want}")
            f.write(arr.tobytes(order="C"))
            total += arr.size
    tmp.replace(out_path)
    return total


def expected_param_count(cfg: dict) -> int:
    h, i, v, n = cfg["hidden_size"], cfg["intermediate_size"], cfg["vocab_size"], cfg["num_layers"]
    per_layer = 4 * h * h + 4 * h + 2 * h + h * i + i + i * h + h + 2 * h
    return v * h + MAX_SEQ_LEN * h + 2 * h + 2 * h + n * per_layer


def main() -> None:
    lock = load_lock()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=lock["default"], choices=sorted(lock["models"]))
    ap.add_argument("--out", type=Path, default=None, help="output dir (default: build/models/<model>)")
    ap.add_argument("--verify-only", action="store_true", help="only verify existing artifacts")
    ap.add_argument("--update-lock", action="store_true", help="(maintainers) re-pin hashes")
    args = ap.parse_args()

    entry = lock["models"][args.model]
    out_dir = args.out or REPO_ROOT / "build" / "models" / args.model
    weights_path = out_dir / "weights.bin"
    vocab_path = out_dir / "vocab.txt"
    cfg = entry["config"]

    if args.verify_only:
        for p, want in ((weights_path, entry["weights_sha256"]), (vocab_path, entry["files"]["vocab.txt"])):
            if not p.exists():
                fail(f"{p} does not exist; run tools/prepare_model.py --model {args.model}")
            got = sha256_file(p)
            if got != want:
                fail(f"{p} sha256 {got} != pinned {want}")
            print(f"  ok  {p.relative_to(REPO_ROOT)}")
        return

    print(f"[1/3] Downloading {entry['repo']}@{entry['revision'][:12]} …")
    paths = download_and_verify(entry, args.update_lock)

    print("[2/3] Loading encoder with transformers …")
    sd, config, torch_model = load_state_dict(paths, cfg)

    print(f"[3/3] Exporting CSWT weights → {weights_path.relative_to(REPO_ROOT)}")
    out_dir.mkdir(parents=True, exist_ok=True)
    n_params = export(sd, config, weights_path)
    if n_params != expected_param_count(cfg):
        fail(f"exported {n_params} params, expected {expected_param_count(cfg)}")
    shutil.copyfile(paths["vocab.txt"], vocab_path)

    digest = sha256_file(weights_path)
    if args.update_lock:
        entry["weights_sha256"] = digest
        with open(LOCK_PATH, "w", encoding="utf-8") as f:
            json.dump(lock, f, indent=2)
            f.write("\n")
        print(f"  lock file updated: {LOCK_PATH.relative_to(REPO_ROOT)}")
    elif digest != entry["weights_sha256"]:
        fail(
            f"exported weights sha256 {digest} != pinned {entry['weights_sha256']}.\n"
            "The export is not reproducible with this toolchain; investigate before shipping."
        )

    meta = {
        "id": args.model,
        "repo": entry["repo"],
        "revision": entry["revision"],
        "license": entry["license"],
        "pooling": entry["pooling"],
        "params": n_params,
        "weights_sha256": digest,
        "vocab_sha256": sha256_file(vocab_path),
        "selftest": {
            "max_abs_tol": 2e-3,
            "texts": SELFTEST_TEXTS,
            "embeddings": reference_embeddings(torch_model, vocab_path, SELFTEST_TEXTS),
        },
    }
    with open(out_dir / "model.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
        f.write("\n")
    size_mb = weights_path.stat().st_size / (1 << 20)
    print(f"\nDone: {n_params:,} params, {size_mb:.2f} MiB, sha256={digest}")


if __name__ == "__main__":
    main()
