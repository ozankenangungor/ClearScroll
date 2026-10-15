"""Reference fixtures for the image model, computed with the original
PyTorch implementation (transformers SiglipModel, fp32) and the reference
tokenizer.

Writes:
  tests/fixtures/siglip_tokenizer_parity.json  — token ids for edge-case texts
  tests/fixtures/siglip_embedding_parity.json  — fp32 PyTorch image/text
      embeddings for the test images (tests/fixtures/images) and prompts,
      using transformers' own SiglipImageProcessor (PIL bicubic resize).

The browser parity test (tests/e2e/vision.test.ts) compares the extension's
int8 ONNX embeddings, computed from the browser's own decoding and resizing,
with these.

Usage (one-off, by a developer; not run in CI — it needs the 813 MB
upstream fp32 checkpoint and Pillow, which the locked tooling does not
include):
  .venv/bin/pip install pillow
  python tools/vision_reference.py --upstream <dir with google/siglip-base-patch16-224
      at the revision pinned in tools/vision_model_lock.json> \
      --tokenizer build/vision/siglip-base-p16-224-int8/tokenizer.json
"""

import argparse
import json
import re
import string
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

TOKENIZER_TEXTS = [
    "a photo of cats.",
    "Football",
    "cryptocurrency",
    "a photo of something related to political protests.",
    "Bitcoin's price!! 2024 ₿",
    "  Ünïcödé   café naïve  ",
    "fast-food & video games",
    "x" * 300,
    "don't they'll we're",
    "日本語のテキスト",
    "emoji 🐱 cat",
    "a photo of $& money",
    "ｆｕｌｌｗｉｄｔｈ ﬁ ligature ½",
    "",
    "luxury cars",
    "an image showing political protests.",
    "Électricité  Straße",
    "the the the " * 30,
]

PROMPTS = ["a photo of cats.", "a photo of dogs.", "a photo of football.", "a photo of cryptocurrency.", "a photo of a landscape."]


def canonicalize(text: str) -> str:
    """transformers' SiglipTokenizer.canonicalize_text (lowercase, no punctuation)."""
    text = text.lower().translate(str.maketrans("", "", string.punctuation))
    return re.sub(r"\s+", " ", text).strip()


def token_ids(tok, text: str) -> list:
    ids = tok.encode(canonicalize(text)).ids  # the post-processor appends </s>
    if len(ids) > 64:
        ids = ids[:63] + [1]
    return ids + [1] * (64 - len(ids))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", required=True, type=Path)
    ap.add_argument("--tokenizer", required=True, type=Path)
    args = ap.parse_args()

    from tokenizers import Tokenizer

    tok = Tokenizer.from_file(str(args.tokenizer))
    fixtures = [{"text": t, "ids": token_ids(tok, t)} for t in TOKENIZER_TEXTS]
    out = REPO / "tests/fixtures/siglip_tokenizer_parity.json"
    out.write_text(json.dumps({"source": "tokenizers + SiglipTokenizer.canonicalize_text", "cases": fixtures}, ensure_ascii=False, indent=1) + "\n")
    print(f"wrote {out.relative_to(REPO)} ({len(fixtures)} cases)")

    import torch
    from PIL import Image
    from transformers import SiglipImageProcessor, SiglipModel

    model = SiglipModel.from_pretrained(args.upstream).eval()
    processor = SiglipImageProcessor.from_pretrained(args.upstream)
    images_dir = REPO / "tests/fixtures/images"
    names = sorted(p.name for p in images_dir.iterdir() if p.suffix in (".jpg", ".webp", ".png"))
    with torch.no_grad():
        pixel = processor(images=[Image.open(images_dir / n).convert("RGB") for n in names], return_tensors="pt")["pixel_values"]
        img = model.get_image_features(pixel_values=pixel)
        img = torch.nn.functional.normalize(img if isinstance(img, torch.Tensor) else img.pooler_output, dim=-1)
        ids = torch.tensor([token_ids(tok, p) for p in PROMPTS])
        txt = model.get_text_features(input_ids=ids)
        txt = torch.nn.functional.normalize(txt if isinstance(txt, torch.Tensor) else txt.pooler_output, dim=-1)
    data = {
        "source": "transformers SiglipModel (fp32) + SiglipImageProcessor, google/siglip-base-patch16-224",
        "logit_scale": model.logit_scale.exp().item(),
        "logit_bias": model.logit_bias.item(),
        "images": {n: [round(float(v), 6) for v in img[i]] for i, n in enumerate(names)},
        "prompts": {p: [round(float(v), 6) for v in txt[i]] for i, p in enumerate(PROMPTS)},
    }
    out = REPO / "tests/fixtures/siglip_embedding_parity.json"
    out.write_text(json.dumps(data) + "\n")
    print(f"wrote {out.relative_to(REPO)} ({len(names)} images, {len(PROMPTS)} prompts)")


if __name__ == "__main__":
    main()
