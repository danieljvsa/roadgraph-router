/**
 * LEB128 variable-length integers, with zigzag for signed values.
 *
 * The graph stores many numbers that are small once expressed as a difference
 * from something nearby — a shape point from the previous one, an edge target
 * from its source node. Writing those as four fixed bytes spends three of them
 * on leading zeros that gzip then has to carry; a varint spends one or two.
 */

/** Maps a signed value onto an unsigned one that stays small when the input is near zero. */
export function zigzag(value: number) {
  return ((value << 1) ^ (value >> 31)) >>> 0;
}

export function unzigzag(value: number) {
  return (value >>> 1) ^ -(value & 1);
}

/** A growable byte sink. Doubling keeps appends amortised O(1). */
export class VarintWriter {
  private bytes: Uint8Array;
  private length = 0;

  constructor(capacity = 1024) {
    this.bytes = new Uint8Array(capacity);
  }

  private reserve(extra: number) {
    if (this.length + extra <= this.bytes.length) return;
    let capacity = this.bytes.length * 2;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  /** Appends an unsigned integer. Values must be below 2^32. */
  push(value: number) {
    this.reserve(5);
    let remaining = value >>> 0;
    while (remaining > 0x7f) {
      this.bytes[this.length++] = (remaining & 0x7f) | 0x80;
      remaining >>>= 7;
    }
    this.bytes[this.length++] = remaining;
  }

  /** Appends a signed integer through zigzag, so small magnitudes stay short. */
  pushSigned(value: number) {
    this.push(zigzag(value));
  }

  get byteLength() {
    return this.length;
  }

  toUint8Array() {
    return this.bytes.subarray(0, this.length);
  }
}

/** Sequential reader over a varint stream. */
export class VarintReader {
  private at: number;

  constructor(private readonly bytes: Uint8Array, start = 0) {
    this.at = start;
  }

  read() {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = this.bytes[this.at++];
      value += shift < 28 ? (byte & 0x7f) << shift : (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("Malformed varint in routing graph.");
    }
  }

  readSigned() {
    return unzigzag(this.read());
  }

  get offset() {
    return this.at;
  }
}
