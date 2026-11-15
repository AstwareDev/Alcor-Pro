/** Insertion-ordered LRU bounded by a byte budget; evicted values are handed to `onEvict` (close bitmaps there). */
export class ByteLru<V> {
  private readonly map = new Map<string, { value: V; bytes: number }>();
  private total = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly onEvict?: (key: string, value: V) => void,
  ) {}

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Marks the entry most recently used. */
  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    this.map.set(key, { value, bytes });
    this.total += bytes;
    this.trim();
  }

  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.map.delete(key);
    this.total -= entry.bytes;
    this.onEvict?.(key, entry.value);
    return true;
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.map.keys()]) if (predicate(key)) this.delete(key);
  }

  clear(): void {
    for (const key of [...this.map.keys()]) this.delete(key);
  }

  /** Evicts least recently used entries (never the newest) until within budget. */
  private trim(): void {
    while (this.total > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
