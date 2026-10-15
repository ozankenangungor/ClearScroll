/**
 * SigLIP image preprocessing (the pinned model's preprocessor_config.json):
 *
 *   convert to RGB → resize the whole image to 224×224 (bicubic; the aspect
 *   ratio is not preserved and nothing is cropped — this is how the model was
 *   trained) → scale to [0, 1] → normalise with mean 0.5 / std 0.5 (→ [−1, 1])
 *   → float32 tensor in NCHW layout.
 *
 * The resize is one drawImage() call with high-quality smoothing (Chrome's
 * cubic resampler), not PIL's bicubic filter; the remaining steps are exact.
 * tests/unit/vision.test.ts checks the arithmetic, and the browser parity
 * test checks the resulting embeddings against PyTorch's.
 */

export const INPUT_SIZE = 224;
export const IMAGE_MEAN = [0.5, 0.5, 0.5] as const;
export const IMAGE_STD = [0.5, 0.5, 0.5] as const;

/** Bytes per RGB frame sent between contexts (224 × 224 × 3). */
export const RGB_FRAME_BYTES = INPUT_SIZE * INPUT_SIZE * 3;
/** Base64 length of one RGB frame (protocol validation). */
export const RGB_FRAME_BASE64_CHARS = Math.ceil(RGB_FRAME_BYTES / 3) * 4;

/** RGBA (canvas ImageData) → packed RGB, dropping alpha. */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  if (rgba.length % 4 !== 0) throw new Error("RGBA buffer length is not a multiple of 4");
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4]!;
    out[i * 3 + 1] = rgba[i * 4 + 1]!;
    out[i * 3 + 2] = rgba[i * 4 + 2]!;
  }
  return out;
}

/** Packed 224×224 RGB → normalised float32 CHW tensor data. */
export function rgbToTensor(rgb: Uint8Array): Float32Array {
  const plane = INPUT_SIZE * INPUT_SIZE;
  if (rgb.length !== plane * 3) throw new Error(`expected ${plane * 3} RGB bytes, got ${rgb.length}`);
  const out = new Float32Array(plane * 3);
  for (let c = 0; c < 3; c++) {
    const mean = IMAGE_MEAN[c]!;
    const std = IMAGE_STD[c]!;
    for (let i = 0; i < plane; i++) out[c * plane + i] = (rgb[i * 3 + c]! / 255 - mean) / std;
  }
  return out;
}

/** Base64 transport for RGB frames over chrome.runtime messaging (JSON only). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * Draw `source` scaled to 224×224 and return its RGB bytes. Transparent
 * areas are composited onto black (PIL's RGBA → RGB conversion drops alpha,
 * which leaves the stored colour; for premultiplied canvas data that is
 * black). Throws a SecurityError for cross-origin images without CORS
 * approval (tainted canvas): callers treat that as "pixels not accessible".
 */
export function drawToRgb(source: CanvasImageSource): Uint8Array {
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, INPUT_SIZE, INPUT_SIZE);
  return rgbaToRgb(ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data);
}
