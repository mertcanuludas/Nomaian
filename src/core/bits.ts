export class BitWriter {
  private bits: number[] = [];

  write(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

export class BitReader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    if (this.pos + count > this.bytes.length * 8) throw new Error('read past end');
    let v = 0;
    for (let i = 0; i < count; i++, this.pos++) {
      v = (v << 1) | ((this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
    }
    return v;
  }

  remaining(): number {
    return this.bytes.length * 8 - this.pos;
  }
}

export function bytesToBits(bytes: ArrayLike<number>): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bits.length; i++) bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return bits;
}

export function bitsToBytes(bits: ArrayLike<number>, byteCount: number): number[] {
  const out = new Array(byteCount).fill(0);
  for (let i = 0; i < byteCount * 8; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

/** CRC-16/CCITT-FALSE. Guards against RS miscorrections when trying many layouts. */
export function crc16(bytes: ArrayLike<number>): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Filler byte at position `i` after the payload+CRC. */
export const filler = (i: number) => (i & 1 ? 0x11 : 0xec);

/** Deterministic whitening sequence (xorshift32) so dot patterns look random. */
export function maskBits(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = 0x6e6f6d61; // "noma"
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = (s >>> 7) & 1;
  }
  return out;
}
