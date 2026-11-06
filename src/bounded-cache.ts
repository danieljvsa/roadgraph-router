/**
 * Caches whose size is counted in bytes, for the decoded tiles and stitched
 * corridors a bundle keeps between routes.
 *
 * Without a bound, every tile a browser tab ever routed through stayed in
 * memory, and every corridor stitched from them: in a city-sized bundle,
 * hundreds of megabytes over a session. Counting entries does not help, since a
 * corridor across a region is many times the size of one across a district.
 */

/**
 * The bytes held in a value's typed arrays, nested ones (spatial index cells,
 * edge limits) included, each array counted once. Plain numbers and object
 * overhead are small beside them and left out.
 */
export function heldBytes(value: unknown, seen = new Set<ArrayBufferView>()): number {
  if (!value || typeof value !== "object") return 0;
  if (ArrayBuffer.isView(value)) {
    if (seen.has(value)) return 0;
    seen.add(value);
    return value.byteLength;
  }
  let total = 0;
  const values = value instanceof Map ? value.values() : Array.isArray(value) ? value : Object.values(value);
  for (const item of values) total += heldBytes(item, seen);
  return total;
}

export type BoundedCacheOptions<V> = {
  /** Most entries to keep; `Infinity` for no count limit. */
  maxEntries: number;
  /** Most bytes to keep, counted when each value resolves. */
  maxBytes: number;
  sizeOf: (value: V) => number;
  /**
   * Whether an entry larger than `maxBytes` on its own is still kept, alone.
   * A tile is: the next route there needs it again. A corridor is not: a
   * corridor that big is a long trip, rarely asked for twice in a row.
   */
  keepOversized: boolean;
  /** Told of each key dropped to make room. */
  onEvict?: (key: string) => void;
};

/**
 * A least-recently-used map of pending values, bounded by count and by bytes.
 * A value's size is known only once it resolves, so it counts from then; a
 * failed one is forgotten, so it is fetched afresh next time.
 */
export class BoundedCache<V> {
  private readonly entries = new Map<string, { value: Promise<V>; bytes: number }>();
  private bytes = 0;

  constructor(private readonly options: BoundedCacheOptions<V>) {}

  get size() {
    return this.entries.size;
  }

  get heldBytes() {
    return this.bytes;
  }

  get(key: string): Promise<V> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-insert so the map's own order is least recently used first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  has(key: string) {
    return this.entries.has(key);
  }

  keys() {
    return this.entries.keys();
  }

  set(key: string, value: Promise<V>) {
    if (this.options.maxEntries <= 0 || this.options.maxBytes <= 0) return;
    this.delete(key);
    const entry = { value, bytes: 0 };
    this.entries.set(key, entry);
    this.trimCount(key);
    value.then(
      (resolved) => {
        // Replaced or dropped meanwhile: nothing to count.
        if (this.entries.get(key) !== entry) return;
        entry.bytes = this.options.sizeOf(resolved);
        this.bytes += entry.bytes;
        this.trimBytes(key);
      },
      () => {
        if (this.entries.get(key) === entry) this.delete(key);
      },
    );
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  private evict(key: string) {
    this.delete(key);
    this.options.onEvict?.(key);
  }

  private trimCount(spare: string) {
    for (const key of [...this.entries.keys()]) {
      if (this.entries.size <= this.options.maxEntries) return;
      if (key !== spare) this.evict(key);
    }
  }

  /** Drops the least recently used until within budget, sparing the entry just counted. */
  private trimBytes(spare: string) {
    // Too big to keep at all: it goes, and nothing else is dropped for it.
    const own = this.entries.get(spare)?.bytes ?? 0;
    if (own > this.options.maxBytes && !this.options.keepOversized) return this.evict(spare);
    for (const key of [...this.entries.keys()]) {
      if (this.bytes <= this.options.maxBytes) return;
      if (key !== spare) this.evict(key);
    }
  }
}
