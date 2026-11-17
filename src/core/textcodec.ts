// Text <-> payload bytes. Two modes; the encoder picks whichever is shorter.
//   MODE_HUFFMAN: static Huffman code tuned to Turkish letter frequencies, with
//                 SHIFT for uppercase and RAW (+16 bits) for any other BMP character.
//   MODE_UTF8:    plain UTF-8 bytes (fallback, e.g. for emoji).
// Header: 4-bit mode + 12-bit length (tokens or bytes).

import { BitReader, BitWriter } from './bits';

export const MODE_HUFFMAN = 1;
export const MODE_UTF8 = 2;

const LOWER = ' abcçdefgğhıijklmnoöprsştuüvyzqwx0123456789.,!?\'"-:;()/+=*@#%\n';
const UPPER = ' ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZQWX';
const SHIFT = LOWER.length;
const RAW = LOWER.length + 1;

// Rough Turkish frequencies per 10k characters. Order matters only for tie-breaking.
// prettier-ignore
const FREQ = [
  1500, 1000, 240, 85, 100, 400, 760, 40, 110, 95, 100, 430, 730, 3, 400, 500, 320, 610, 210, 70, 70,
  590, 250, 150, 260, 270, 160, 85, 280, 130, 1, 2, 2,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
  70, 70, 15, 15, 15, 5, 8, 5, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 10,
  60, 3, // SHIFT, RAW
];
if (FREQ.length !== LOWER.length + 2) throw new Error('frequency table out of sync with alphabet');

/** Canonical Huffman code built deterministically from FREQ. */
function buildCode(): { codes: Array<[number, number]>; decode: Map<string, number> } {
  type Node = { w: number; id: number; sym?: number; kids?: [Node, Node] };
  let nodes: Node[] = FREQ.map((w, i) => ({ w, id: i, sym: i }));
  let nextId = nodes.length;
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.w - b.w || a.id - b.id);
    const [a, b] = nodes;
    nodes = [{ w: a.w + b.w, id: nextId++, kids: [a, b] }, ...nodes.slice(2)];
  }
  const lens = new Array(FREQ.length).fill(0);
  const walk = (n: Node, d: number) => {
    if (n.kids) {
      walk(n.kids[0], d + 1);
      walk(n.kids[1], d + 1);
    } else lens[n.sym!] = d;
  };
  walk(nodes[0], 0);
  const order = lens.map((l, s) => [l, s]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const codes: Array<[number, number]> = new Array(FREQ.length);
  const decode = new Map<string, number>();
  let code = 0;
  let prevLen = order[0][0];
  for (const [len, sym] of order) {
    code <<= len - prevLen;
    prevLen = len;
    codes[sym] = [code, len];
    decode.set(`${len}:${code}`, sym);
    code++;
  }
  return { codes, decode };
}

const { codes: CODES, decode: DECODE } = buildCode();

const lowerIndex = new Map<string, number>();
const upperIndex = new Map<string, number>();
for (let i = 0; i < LOWER.length; i++) lowerIndex.set(LOWER[i], i);
for (let i = 1; i < UPPER.length; i++) upperIndex.set(UPPER[i], i);

/** Token list for Huffman mode; RAW is followed by a pseudo-token holding the code point. */
function tokenize(text: string): number[] | null {
  const out: number[] = [];
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const lo = lowerIndex.get(ch);
    if (lo !== undefined) {
      out.push(lo);
      continue;
    }
    const up = upperIndex.get(ch);
    if (up !== undefined) {
      out.push(SHIFT, up);
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) return null;
    out.push(RAW, -cp - 1);
  }
  return out;
}

function huffmanBits(tokens: number[]): number {
  return tokens.reduce((s, t) => s + (t < 0 ? 16 : CODES[t][1]), 0);
}

/** Encodes text into a payload byte array (header included). */
export function encodeText(text: string): Uint8Array {
  const tokens = tokenize(text);
  const utf8 = new TextEncoder().encode(text);
  const w = new BitWriter();
  if (tokens && tokens.length < 4096 && huffmanBits(tokens) <= utf8.length * 8) {
    w.write(MODE_HUFFMAN, 4);
    w.write(tokens.length, 12);
    for (const t of tokens) {
      if (t < 0) w.write(-t - 1, 16);
      else w.write(CODES[t][0], CODES[t][1]);
    }
  } else {
    if (utf8.length >= 4096) throw new Error('Metin çok uzun');
    w.write(MODE_UTF8, 4);
    w.write(utf8.length, 12);
    for (const b of utf8) w.write(b, 8);
  }
  return w.toBytes();
}

function readSymbol(r: BitReader): number {
  let code = 0;
  for (let len = 1; len <= 24; len++) {
    code = (code << 1) | r.read(1);
    const s = DECODE.get(`${len}:${code}`);
    if (s !== undefined) return s;
  }
  throw new Error('bad huffman code');
}

/** Decodes a payload produced by `encodeText`. Throws on malformed input. */
export function decodeText(bytes: Uint8Array): string {
  const r = new BitReader(bytes);
  const mode = r.read(4);
  const len = r.read(12);
  if (mode === MODE_UTF8) {
    if (len * 8 > r.remaining()) throw new Error('length out of range');
    const buf = new Uint8Array(len);
    for (let i = 0; i < len; i++) buf[i] = r.read(8);
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  }
  if (mode !== MODE_HUFFMAN) throw new Error('unknown mode');
  let out = '';
  for (let i = 0; i < len; i++) {
    const s = readSymbol(r);
    if (s === SHIFT) {
      const u = readSymbol(r);
      i++;
      if (u < 1 || u >= UPPER.length) throw new Error('bad shift');
      out += UPPER[u];
    } else if (s === RAW) {
      out += String.fromCharCode(r.read(16));
      i++;
    } else {
      out += LOWER[s];
    }
  }
  return out;
}
