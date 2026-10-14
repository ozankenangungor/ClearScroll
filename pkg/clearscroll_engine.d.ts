export default function init(opts: { module_or_path: string | URL }): Promise<unknown>;
export function init_engine(weights: Uint8Array, vocab: string, backend: string): Promise<number>;
export function embed_batch(texts: string[]): Promise<Float32Array>;
