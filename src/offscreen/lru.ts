/** Minimal LRU cache on top of Map's insertion order. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    if (!(capacity > 0)) throw new Error("LRU capacity must be positive");
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      this.map.delete(this.map.keys().next().value as K);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
