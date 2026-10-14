// Types for scripts/lib.mjs (used by the TypeScript scripts).
export const REPO: string;
export const MODEL: string;
export const DTYPE: string;
export const MODEL_DIR: string;
export const LOCK: { default: string; models: Record<string, Record<string, any>> };
export function modelDir(model: string, dtype: string): string;
export function weightsShaKey(dtype: string): string;
export function sha256(file: string): string;
export function fail(msg: string): never;
export function step(msg: string): void;
