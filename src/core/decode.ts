// Reads spirals from camera frames or photos, a piece at a time.
//
//   1. Markers (pairs of fused rings) are found anywhere in the frame; each gives a position, the direction
//      of the writing through it, and a scale.
//   2. Neighbouring markers that the chain visibly runs between are linked into chains. Between two linked
//      markers the line is a smooth curve set by their positions and directions, so the writing of the gap
//      can be read without knowing which spiral it belongs to or where on it it lies.
//   3. A chain read from a frame is a run of gaps. The Reader remembers runs for a short while and joins
//      runs from different frames where their contents overlap, adding up repeated readings, so a spiral
//      can be panned across bit by bit and still be read as one.
//   4. Every run of GAPS_PER_SEGMENT gaps is tried as a segment: a Reed-Solomon codeword that names its
//      message and its place in it. Verified segments are kept until a whole message is there.

import { crc16, filler } from './bits';
import { binarize, binarizeBlocks, findMarkers, Gray, Marker, toGray } from './detect';
import { CRC_BYTES, HEADER_BYTES, NO_PARENT, SEGMENT_MASK } from './encode';
import {
  bitSymbol, BITS_PER_VERTEX, BOND, CHUNK_BYTES, GAP_BONDS, GAP_LEN, GAP_SYMBOLS, GAP_VERTICES, GAPS_PER_SEGMENT, MAX_SEGMENTS,
  PARITY_BYTES, SEGMENT_BYTES, SEGMENT_HEADER, SEGMENT_SYMBOLS, vertexInGap, vertexSide,
} from './layout';
import { rsDecode } from './rs';
import { flipValue, hollowAt, GRID_U, GRID_W, kinkPoint, valueScores } from './shapes';
import { decodeText, encodeText } from './textcodec';

export type Pt = { x: number; y: number };

export interface DecodedMessage {
  thread: number;
  index: number;
  /** index of the message this one replies to, or -1 */
  parent: number;
  /** number of messages in the whole conversation */
  total: number;
  author: string;
  text: string;
  /** true when the ink was darker than the surface */
  darkInk: boolean;
  /** bytes repaired by error correction */
  corrected: number;
}

/** A message seen in part: how many of its segments have been read. */
export interface Partial {
  /** low two bits of the message's index: all a segment says about which message it is */
  index: number;
  segments: number;
  have: number;
}

const K = GAP_VERTICES;
/** Values a vertex can take. */
const NV = 1 << BITS_PER_VERTEX;

function sampler(g: Gray) {
  const { data, width: w, height: h } = g;
  return (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 128;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const i = y0 * w + x0;
    return (
      data[i] * (1 - fx) * (1 - fy) + data[i + 1] * fx * (1 - fy) + data[i + w] * (1 - fx) * fy + data[i + w + 1] * fx * fy
    );
  };
}

/** Whether there is ink at or right next to a point of a binarised image. */
function inkAt(bin: Uint8Array, w: number, h: number, x: number, y: number): number {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) return 0;
  const i = yi * w + xi;
  return bin[i] || bin[i - 1] || bin[i + 1] || bin[i - w] || bin[i + w] ? 1 : 0;
}

/** A marker's direction, turned to point along `d`. */
function towards(m: Marker, dx: number, dy: number): [number, number] {
  return m.tx * dx + m.ty * dy >= 0 ? [m.tx, m.ty] : [-m.tx, -m.ty];
}

const CURVE_STEPS = 64;

/**
 * The line between two neighbouring markers, as image positions: a cubic leaving each marker along its
 * direction and bent like a circular arc, parametrised by arc length so that template positions along the
 * gap map evenly onto it.
 */
export class GapCurve {
  private xs = new Float64Array(CURVE_STEPS + 1);
  private ys = new Float64Array(CURVE_STEPS + 1);
  private cum = new Float64Array(CURVE_STEPS + 1);
  /** pixels per glyph unit along and across the line */
  readonly along: number;
  readonly across: number;
  /** how a step across the line lands, at either end (see Marker) */
  private skew0: number;
  private skew1: number;
  private across0: number;
  private across1: number;

  constructor(a: Marker, b: Marker) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const ta = towards(a, dx, dy);
    const tb = towards(b, dx, dy);
    const theta = Math.acos(Math.max(-1, Math.min(1, ta[0] * tb[0] + ta[1] * tb[1])));
    const k = theta < 1e-3 ? dist / 3 : (dist * (2 / 3) * Math.tan(theta / 4)) / Math.sin(theta / 2);
    const p1 = [a.x + ta[0] * k, a.y + ta[1] * k];
    const p2 = [b.x - tb[0] * k, b.y - tb[1] * k];
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      const c0 = u * u * u;
      const c1 = 3 * u * u * t;
      const c2 = 3 * u * t * t;
      const c3 = t * t * t;
      this.xs[i] = c0 * a.x + c1 * p1[0] + c2 * p2[0] + c3 * b.x;
      this.ys[i] = c0 * a.y + c1 * p1[1] + c2 * p2[1] + c3 * b.y;
      if (i) this.cum[i] = this.cum[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
    }
    this.along = this.cum[CURVE_STEPS] / GAP_LEN;
    this.across = this.along * ((a.across + b.across) / 2);
    this.skew0 = a.skew;
    this.skew1 = b.skew;
    this.across0 = a.across;
    this.across1 = b.across;
  }

  /** Template position (s from the first marker's centre, v across) -> image point. */
  at(s: number, v: number): [number, number] {
    const { xs, ys, cum } = this;
    const target = (Math.max(0, Math.min(GAP_LEN, s)) / GAP_LEN) * cum[CURVE_STEPS];
    let lo = 0;
    let hi = CURVE_STEPS;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const seg = cum[hi] - cum[lo] || 1;
    const f = (target - cum[lo]) / seg;
    const tx = (xs[hi] - xs[lo]) / seg;
    const ty = (ys[hi] - ys[lo]) / seg;
    const x = xs[lo] + (xs[hi] - xs[lo]) * f;
    const y = ys[lo] + (ys[hi] - ys[lo]) * f;
    // The step across follows the distortion found at the markers, blended along the gap.
    const w = target / cum[CURVE_STEPS];
    const sk = (this.skew0 + (this.skew1 - this.skew0) * w) * v * this.along;
    const ac = (this.across0 + (this.across1 - this.across0) * w) * v * this.along;
    return [x + sk * tx - ac * ty, y + sk * ty + ac * tx];
  }
}

/** How the zigzag actually sits on a gap's curve. */
interface GapFit {
  curve: GapCurve;
  /** +1 when vertex 0 (next to the first marker) sits at +v */
  phase: number;
  /** template offsets along and across that line the zigzag up best */
  ds: number;
  dv: number;
  /** share of the chain's points that landed on ink */
  fit: number;
}

const NUDGE = [-0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45].map((f) => f * BOND);
/** Each vertex of a gap: arc position, offset across the line, and the empty point across from it. */
const VERTS = Array.from({ length: K }, (_, j) => {
  const [s, v] = vertexInGap(j);
  const [hollow, clear] = hollowAt(j);
  // Only points well clear of any ink are checked: the chain's wander leaves some vertices little room.
  return { s, v, hollow, checked: clear >= 3 };
});
const CHECKED = VERTS.filter((x) => x.checked).length;

/**
 * Each bond between data vertices: its middle, where a straight bond has ink, and the two points one broken
 * either way bends through (a gap read from the other end sees it bent the other way).
 */
const BONDS = Array.from({ length: GAP_BONDS }, (_, b) => {
  const a: [number, number] = [VERTS[b].s, VERTS[b].v];
  const c: [number, number] = [VERTS[b + 1].s, VERTS[b + 1].v];
  const mid: [number, number] = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
  const k = kinkPoint(a, c);
  return { mid, bends: [k, [2 * mid[0] - k[0], 2 * mid[1] - k[1]] as [number, number]] };
});
/** Where a gap's bond scores start in its score array: [straight, broken] per bond, after the vertices'. */
const BOND_BASE = K * NV;
const GAP_SCORES = BOND_BASE + 2 * GAP_BONDS;

/**
 * Lines the zigzag up with the ink between two markers: which way it zigs, and a small offset. Returns null
 * unless the chain clearly runs there, which is how links across empty space or between different lines
 * are rejected. `phases` limits which way the zigzag may go.
 */
export function fitGap(bin: Uint8Array, w: number, h: number, curve: GapCurve, phases = [1, -1]): GapFit | null {
  let best: GapFit | null = null;
  let bestScore = -Infinity;
  let bestOff = 0;
  for (const phase of phases)
    for (const ds of NUDGE)
      for (const dv of NUDGE) {
        let chain = 0;
        let off = 0;
        for (let j = 0; j < K; j++) {
          const vj = VERTS[j];
          const s = vj.s + ds;
          chain += inkAt(bin, w, h, ...curve.at(s, phase * vj.v + dv));
          // Straight across from the vertex, where the chain and its neighbours leave room, there is never ink.
          if (vj.checked) off += inkAt(bin, w, h, ...curve.at(s, phase * vj.hollow + dv));
          if (j + 1 < K) {
            // The bond runs through its middle, or bends out to one side.
            const bond = BONDS[j];
            chain += Math.max(
              ...[bond.mid, ...bond.bends].map(([bs, bv]) => inkAt(bin, w, h, ...curve.at(bs + ds, phase * bv + dv))),
            );
          }
        }
        const score = chain - off;
        if (score > bestScore) {
          bestScore = score;
          bestOff = off;
          best = { curve, phase, ds, dv, fit: chain / (2 * K - 1) };
        }
      }
  return best && best.fit >= 0.7 && bestOff <= 0.4 * CHECKED ? best : null;
}

/**
 * Small corrections tried at each vertex, since neither the curve nor the scale across it is exact: a shift
 * along the line (bonds) and a stretch away from it. Each value scores its best fit.
 */
const SHIFTS = [-0.15, 0, 0.15];
const LIFTS = [-0.1, 0, 0.1];
const STRETCHES = [0.93, 1, 1.07];

/**
 * Scores of every value at every vertex of a gap, in the order from the first marker to the second, then of
 * each bond being straight or broken.
 */
function readGap(sample: (x: number, y: number) => number, darkInk: boolean, f: GapFit): Float32Array {
  const out = new Float32Array(GAP_SCORES).fill(-Infinity);
  const buf = new Float32Array(GRID_U.length * GRID_W.length);
  // Where each vertex matched best: its shift along the line and across it, in the gap's coordinates.
  const found = Array.from({ length: K }, () => ({ score: -Infinity, ds: 0, dv: 0 }));
  for (let j = 0; j < K; j++) {
    const side = vertexSide(j) * f.phase;
    const vj = VERTS[j];
    for (const du of SHIFTS)
      for (const dw of LIFTS)
      for (const st of STRETCHES) {
        const s = vj.s + f.ds + du * BOND;
        let k = 0;
        for (const gu of GRID_U)
          for (const gw of GRID_W) {
            const v = sample(...f.curve.at(s + gu * BOND, f.phase * vj.v + side * (gw * st + dw) * BOND + f.dv));
            buf[k++] = darkInk ? 255 - v : v;
          }
        const scores = valueScores(buf, j);
        for (let v = 0; v < NV; v++) {
          out[j * NV + v] = Math.max(out[j * NV + v], scores[v]);
          if (scores[v] > found[j].score) found[j] = { score: scores[v], ds: du * BOND, dv: side * dw * BOND };
        }
      }
  }
  // A bond is broken when its ink is out at one side rather than in the middle. Its ends are the vertices
  // either side, so it is looked for where they were found. All the broken bonds of a gap bend the same way
  // round, which depends on which way the gap is read: the side where ink turns up more often is that way,
  // and only it is looked at, since the other may catch a neighbouring group.
  const inkAt = (b: number, [bs, bv]: [number, number]) => {
    const os = (found[b].ds + found[b + 1].ds) / 2;
    const ov = (found[b].dv + found[b + 1].dv) / 2;
    const v = sample(...f.curve.at(bs + f.ds + os, f.phase * bv + f.dv + ov));
    return darkInk ? 255 - v : v;
  };
  // A bend is looked for a little nearer and further out too, as the scale across is not exact.
  const bendInk = (b: number, side: number) => {
    const bond = BONDS[b];
    const [ks, kv] = bond.bends[side];
    let best = 0;
    for (const t of [0.8, 1, 1.2])
      best = Math.max(best, inkAt(b, [bond.mid[0] + (ks - bond.mid[0]) * t, bond.mid[1] + (kv - bond.mid[1]) * t]));
    return best;
  };
  const mids = BONDS.map((bond, b) => inkAt(b, bond.mid));
  const bends = [0, 1].map((side) => BONDS.map((_, b) => bendInk(b, side)));
  const lean = [0, 1].map((side) => bends[side].reduce((t, k, b) => t + Math.max(0, k - mids[b]), 0));
  const side = lean[0] >= lean[1] ? 0 : 1;
  BONDS.forEach((_, b) => {
    const d = (mids[b] - bends[side][b]) / 255;
    out[BOND_BASE + 2 * b] = d;
    out[BOND_BASE + 2 * b + 1] = -d;
  });
  return out;
}

/** A chain of markers read from one frame: its gaps in order, and where its markers are (for display). */
export interface ChainRead {
  gaps: Float32Array[];
  markers: Pt[];
  /** how each gap lined up (for diagnostics) */
  fits: Array<Omit<GapFit, 'curve'>>;
}

/** More markers than this means clutter or noise, not writing. */
const MAX_MARKERS = 400;

/** Finds the chains of writing in one binarised frame and reads their gaps. */
export function readChains(g: Gray, bin: Uint8Array, darkInk: boolean): ChainRead[] {
  const { width: w, height: h } = g;
  const markers = findMarkers(bin, w, h);
  if (markers.length < 2 || markers.length > MAX_MARKERS) return [];

  // Candidate links: the right distance apart for their scale, both pointing roughly at each other, and
  // bending consistently, like an arc.
  const links: Array<{ a: number; b: number; cost: number }> = [];
  for (let i = 0; i < markers.length; i++) {
    const A = markers[i];
    for (let j = i + 1; j < markers.length; j++) {
      const B = markers[j];
      const sr = A.scale / B.scale;
      // Neighbours on a line are nearly the same size; fused rings in the writing are smaller than markers.
      if (sr < 0.7 || sr > 1.43) continue;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const dist = Math.hypot(dx, dy);
      const S = (GAP_LEN * (A.scale + B.scale)) / 2;
      if (dist < 0.45 * S || dist > 1.2 * S) continue;
      const ta = towards(A, dx, dy);
      const tb = towards(B, dx, dy);
      const ca = (ta[0] * dx + ta[1] * dy) / dist;
      const cb = (tb[0] * dx + tb[1] * dy) / dist;
      const angA = Math.acos(Math.min(1, ca));
      const angB = Math.acos(Math.min(1, cb));
      if (angA > 1.35 || angB > 1.35) continue;
      const turnA = ta[0] * dy - ta[1] * dx;
      const turnB = dx * tb[1] - dy * tb[0];
      if (turnA * turnB < 0 && Math.min(angA, angB) > 0.3) continue;
      const theta = angA + angB;
      const chord = theta < 1e-3 ? 1 : Math.sin(theta / 2) / (theta / 2);
      const stretch = Math.abs(Math.log(dist / S / chord));
      if (stretch > 0.35) continue;
      const fit = fitGap(bin, w, h, new GapCurve(A, B));
      if (!fit) continue;
      links.push({ a: i, b: j, cost: stretch + Math.abs(angA - angB) + (1 - fit.fit) });
    }
  }
  links.sort((p, q) => p.cost - q.cost);

  // Each marker joins at most one neighbour on either side.
  const side = (m: Marker, other: Marker) => ((other.x - m.x) * m.tx + (other.y - m.y) * m.ty >= 0 ? 0 : 1);
  const nb = markers.map(() => [-1, -1]);
  for (const { a, b } of links) {
    const sa = side(markers[a], markers[b]);
    const sb = side(markers[b], markers[a]);
    if (nb[a][sa] >= 0 || nb[b][sb] >= 0) continue;
    nb[a][sa] = b;
    nb[b][sb] = a;
  }

  const sample = sampler(g);
  const visited = new Uint8Array(markers.length);
  const chains: ChainRead[] = [];
  const walk = (start: number) => {
    const order = [start];
    visited[start] = 1;
    let prev = -1;
    let cur = start;
    for (;;) {
      const next = nb[cur].find((n) => n >= 0 && n !== prev && !visited[n]);
      if (next === undefined) break;
      order.push(next);
      visited[next] = 1;
      prev = cur;
      cur = next;
    }
    // The zigzag goes the same way all along a chain (as seen walking it), so a gap that seems to zig the
    // other way was misjudged: it is fitted again the majority's way.
    const curves = order.slice(1).map((m, k) => new GapCurve(markers[order[k]], markers[m]));
    let fits = curves.map((c) => fitGap(bin, w, h, c));
    const vote = fits.reduce((n, f) => n + (f ? f.phase : 0), 0);
    if (vote) {
      const phase = Math.sign(vote);
      fits = fits.map((f, k) => (f && f.phase !== phase ? fitGap(bin, w, h, curves[k], [phase]) : f));
    }
    // Read the gaps in walking order; a gap that does not line up splits the chain.
    let run: ChainRead = { gaps: [], fits: [], markers: [{ x: markers[order[0]].x, y: markers[order[0]].y }] };
    fits.forEach((fit, k) => {
      const B = markers[order[k + 1]];
      if (!fit) {
        if (run.gaps.length) chains.push(run);
        run = { gaps: [], fits: [], markers: [{ x: B.x, y: B.y }] };
        return;
      }
      run.gaps.push(readGap(sample, darkInk, fit));
      run.fits.push({ phase: fit.phase, ds: fit.ds, dv: fit.dv, fit: fit.fit });
      run.markers.push({ x: B.x, y: B.y });
    });
    if (run.gaps.length) chains.push(run);
  };
  // Chains are walked from an end; whatever is left over is a loop, walked from anywhere.
  markers.forEach((_, i) => {
    if (!visited[i] && nb[i].filter((n) => n >= 0).length === 1) walk(i);
  });
  markers.forEach((_, i) => {
    if (!visited[i] && nb[i].some((n) => n >= 0)) walk(i);
  });
  return chains;
}

// ---------- remembering and joining what was seen ----------

/** Best value at each vertex of a gap and for each bond, and by how much it beat the runner-up. */
function hard(gap: Float32Array): { values: Uint8Array; margins: Float32Array } {
  const values = new Uint8Array(GAP_SYMBOLS);
  const margins = new Float32Array(GAP_SYMBOLS);
  for (let j = 0; j < K; j++) {
    let best = -Infinity;
    let second = -Infinity;
    let arg = 0;
    for (let v = 0; v < NV; v++) {
      const s = gap[j * NV + v];
      if (s > best) {
        second = best;
        best = s;
        arg = v;
      } else if (s > second) second = s;
    }
    values[j] = arg;
    margins[j] = best - second;
  }
  for (let b = 0; b < GAP_BONDS; b++) {
    const straight = gap[BOND_BASE + 2 * b];
    const broken = gap[BOND_BASE + 2 * b + 1];
    values[K + b] = broken > straight ? 1 : 0;
    margins[K + b] = Math.abs(broken - straight);
  }
  return { values, margins };
}

/** The same gap read from the other end: vertices and bonds reversed, and groups mirrored. */
function reverseGap(gap: Float32Array): Float32Array {
  const out = new Float32Array(GAP_SCORES);
  for (let j = 0; j < K; j++)
    for (let v = 0; v < NV; v++) out[j * NV + flipValue(v)] = gap[(K - 1 - j) * NV + v];
  for (let b = 0; b < GAP_BONDS; b++)
    for (let t = 0; t < 2; t++) out[BOND_BASE + 2 * b + t] = gap[BOND_BASE + 2 * (GAP_BONDS - 1 - b) + t];
  return out;
}

const reverseRun = (gaps: Float32Array[]) => gaps.map(reverseGap).reverse();

interface Contig {
  /** summed scores per gap */
  gaps: Float32Array[];
  /** hard values, kept in step with gaps */
  values: Uint8Array[];
  seen: number;
  dirty: boolean;
}

/** Symbols that may disagree where two readings of the same gaps overlap, per gap of overlap. */
const MISMATCH_PER_GAP = 4;

/** Where `run` overlaps `c` (run[i] over c[i + off]), with the most overlap and fewest disagreements. */
function bestOverlap(c: Uint8Array[], run: Uint8Array[]) {
  let best: { off: number; n: number; bad: number } | null = null;
  for (let off = -(run.length - 1); off < c.length; off++) {
    let n = 0;
    let bad = 0;
    for (let i = Math.max(0, -off); i < run.length && i + off < c.length; i++) {
      n++;
      const a = c[i + off];
      const b = run[i];
      for (let j = 0; j < GAP_SYMBOLS; j++) if (a[j] !== b[j]) bad++;
    }
    if (bad > MISMATCH_PER_GAP * n) continue;
    if (!best || n > best.n || (n === best.n && bad < best.bad)) best = { off, n, bad };
  }
  return best;
}

/** How long runs are remembered without being seen again, in milliseconds. */
const MEMORY_MS = 20000;
const MAX_CONTIGS = 80;

export interface FrameResult {
  /** every message read so far, complete */
  messages: DecodedMessage[];
  /** messages of which only some segments have been read */
  partial: Partial[];
  /** marker positions of the chains found in this frame, for display */
  chains: Pt[][];
  ms: number;
}

export interface FrameOptions {
  /** which thresholding passes to run (0..BINARIZERS-1); all by default */
  passes?: number[];
  /** ink polarity, if known (true = dark ink on light ground); both are tried by default */
  darkInk?: boolean;
  /** clock for forgetting old runs; Date.now() by default */
  now?: number;
}

/** Number of thresholding passes a full decode tries. */
export const BINARIZERS = 3;

interface SegmentRead {
  chunk: number[];
  votes: number;
  corrected: number;
}

/** Short-term memory for reading a conversation from many frames. */
export class Reader {
  private contigs: Contig[] = [];
  /** verified segments: `${index}:${segments}` -> segment -> chunk (hex) -> how often it was read */
  private segments = new Map<string, Array<Map<string, SegmentRead>>>();
  private complete = new Map<string, DecodedMessage>();
  /** polarity of the ink, once something has been read */
  darkInk: boolean | undefined;

  addFrame(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, opts: FrameOptions = {}): FrameResult {
    const t0 = Date.now();
    const now = opts.now ?? t0;
    const g = toGray(rgba, width, height);
    const minDim = Math.min(width, height);
    const binarizers = [
      (dark: boolean) => binarizeBlocks(g, 6, dark),
      (dark: boolean) => binarizeBlocks(g, 12, dark),
      (dark: boolean) => binarize(g, minDim / 8, dark),
    ];
    const shown: Pt[][] = [];
    const polarity = opts.darkInk ?? this.darkInk;
    for (const pass of opts.passes ?? binarizers.map((_, i) => i)) {
      for (const darkInk of [true, false]) {
        if (polarity !== undefined && polarity !== darkInk) continue;
        const chains = readChains(g, binarizers[pass](darkInk), darkInk);
        for (const c of chains) {
          shown.push(c.markers);
          if (c.gaps.length >= 2) this.remember(c.gaps, now);
        }
        if (this.decodeRuns(darkInk)) this.darkInk ??= darkInk;
      }
    }
    this.contigs = this.contigs.filter((c) => now - c.seen < MEMORY_MS);
    return { messages: this.messages(), partial: this.partial(), chains: shown, ms: Date.now() - t0 };
  }

  messages(): DecodedMessage[] {
    return [...this.complete.values()];
  }

  partial(): Partial[] {
    const out: Partial[] = [];
    for (const [key, segs] of this.segments) {
      const [index, segments] = key.split(':').map(Number);
      if ([...this.complete.values()].some((m) => m.index === index)) continue;
      out.push({ index, segments, have: segs.filter((s) => s.size).length });
    }
    return out;
  }

  /** Adds a run of gaps read from a frame, joining it to what was seen before where they overlap. */
  private remember(run: Float32Array[], now: number) {
    const fwd = run.map((gap) => hard(gap).values);
    const rev = reverseRun(run);
    const back = rev.map((gap) => hard(gap).values);
    let target: { c: Contig; off: number; flip: boolean } | null = null;
    let bestN = 0;
    for (const c of this.contigs) {
      for (const flip of [false, true]) {
        const o = bestOverlap(c.values, flip ? back : fwd);
        // A single gap of overlap is trusted only if that gap is unlike any other remembered one, since two
        // messages with the same words would share one.
        if (!o || o.n < 1 || o.n <= bestN) continue;
        if (o.n === 1 && !this.unique(flip ? back : fwd, o.off)) continue;
        bestN = o.n;
        target = { c, off: o.off, flip };
      }
    }
    if (!target) {
      this.contigs.push({ gaps: run.map((x) => x.slice()), values: fwd, seen: now, dirty: true });
      if (this.contigs.length > MAX_CONTIGS) this.contigs.sort((a, b) => b.seen - a.seen).splice(MAX_CONTIGS);
      return;
    }
    const c = target.c;
    this.merge(c, target.flip ? rev : run, target.off);
    c.seen = now;
    // The run may have bridged two remembered runs.
    for (const other of this.contigs) {
      if (other === c) continue;
      for (const flip of [false, true]) {
        const seq = flip ? reverseRun(other.gaps) : other.gaps;
        const o = bestOverlap(c.values, seq.map((gap) => hard(gap).values));
        if (!o || o.n < 2) continue;
        this.merge(c, seq, o.off);
        this.contigs = this.contigs.filter((x) => x !== other);
        return;
      }
    }
  }

  /** Whether the gap of `run` that overlaps at `off` matches exactly one remembered gap, either way round. */
  private unique(run: Uint8Array[], off: number): boolean {
    const gap = run[Math.max(0, -off)];
    let matches = 0;
    for (const other of this.contigs)
      for (const vals of [...other.values, ...reverseRun(other.gaps).map((x) => hard(x).values)]) {
        let bad = 0;
        for (let j = 0; j < GAP_SYMBOLS; j++) if (vals[j] !== gap[j]) bad++;
        if (bad <= MISMATCH_PER_GAP) matches++;
      }
    return matches === 1;
  }

  /** Adds `run` into `c`, run[i] landing on c.gaps[i + off]. */
  private merge(c: Contig, run: Float32Array[], off: number) {
    if (off < 0) {
      const before = -off;
      c.gaps.unshift(...run.slice(0, before).map((x) => x.slice()));
      run = run.slice(before);
      off = before;
    }
    run.forEach((gap, i) => {
      const k = i + off;
      if (k < c.gaps.length) for (let j = 0; j < gap.length; j++) c.gaps[k][j] += gap[j];
      else c.gaps.push(gap.slice());
    });
    c.values = c.gaps.map((gap) => hard(gap).values);
    c.dirty = true;
  }

  /** Tries every run of GAPS_PER_SEGMENT gaps of changed contigs as a segment. Returns whether any was new. */
  private decodeRuns(darkInk: boolean): boolean {
    let any = false;
    for (const c of this.contigs) {
      if (!c.dirty) continue;
      c.dirty = false;
      for (const gaps of [c.gaps, reverseRun(c.gaps)])
        for (let off = 0; off + GAPS_PER_SEGMENT <= gaps.length; off++) {
          const seg = decodeSegment(gaps.slice(off, off + GAPS_PER_SEGMENT));
          if (seg && this.addSegment(seg, darkInk)) any = true;
        }
    }
    return any;
  }

  private addSegment(s: NonNullable<ReturnType<typeof decodeSegment>>, darkInk: boolean): boolean {
    const key = `${s.index}:${s.segments}`;
    let segs = this.segments.get(key);
    if (!segs) {
      segs = Array.from({ length: s.segments }, () => new Map<string, SegmentRead>());
      this.segments.set(key, segs);
    }
    const hex = s.chunk.map((b) => b.toString(16).padStart(2, '0')).join('');
    const prev = segs[s.seg].get(hex);
    if (prev) {
      prev.votes++;
      return false;
    }
    segs[s.seg].set(hex, { chunk: s.chunk, votes: 1, corrected: s.corrected });
    if (segs.every((m) => m.size)) this.assemble(segs, s.index, darkInk);
    return true;
  }

  /** Puts a message together from its segments, trying the likeliest readings first. */
  private assemble(segs: Array<Map<string, SegmentRead>>, index: number, darkInk: boolean) {
    const options = segs.map((m) => [...m.values()].sort((a, b) => b.votes - a.votes).slice(0, 3));
    const combos: SegmentRead[][] = [[]];
    for (const opts of options) {
      const next: SegmentRead[][] = [];
      for (const c of combos) for (const o of opts) if (next.length < 1024) next.push([...c, o]);
      combos.splice(0, combos.length, ...next);
    }
    for (const combo of combos) {
      const msg = parse(combo.flatMap((s) => s.chunk));
      // Segments only carry two bits of the index, so others' may have been mixed in: the CRC sorts it out.
      if (!msg || (msg.index & 3) !== index) continue;
      this.complete.set(`${msg.thread}:${msg.index}`, {
        ...msg, darkInk, corrected: combo.reduce((n, s) => n + s.corrected, 0),
      });
      return;
    }
  }
}

/** A run of gaps as one segment codeword; null unless it decodes and its header makes sense. */
function decodeSegment(gaps: Float32Array[]) {
  const values = new Uint8Array(SEGMENT_SYMBOLS);
  const margins = new Float32Array(SEGMENT_SYMBOLS);
  gaps.forEach((gap, g) => {
    const h = hard(gap);
    values.set(h.values, g * GAP_SYMBOLS);
    margins.set(h.margins, g * GAP_SYMBOLS);
  });
  const block: number[] = new Array(SEGMENT_BYTES).fill(0);
  // Confidence of a byte = its weakest symbol; used to pick erasures when plain decoding fails.
  const conf: number[] = new Array(SEGMENT_BYTES).fill(Infinity);
  for (let k = 0; k < SEGMENT_BYTES * 8; k++) {
    const [sym, shift] = bitSymbol(k);
    if (((values[sym] >> shift) & 1) ^ SEGMENT_MASK[k]) block[k >> 3] |= 0x80 >> (k & 7);
    conf[k >> 3] = Math.min(conf[k >> 3], margins[sym]);
  }
  let data: number[] | null = null;
  try {
    data = rsDecode(block, PARITY_BYTES);
  } catch {
    // Retry treating the least confident bytes as erasures. Keep half the parity for error detection.
    const idx = conf.map((c, i) => [c, i] as const).sort((x, y) => x[0] - y[0]);
    for (const k of [2, 4]) {
      try {
        data = rsDecode(block, PARITY_BYTES, idx.slice(0, k).map((x) => x[1]));
        break;
      } catch {
        /* try next */
      }
    }
  }
  if (!data) return null;
  const index = data[0] >> 6;
  const seg = (data[0] >> 3) & 7;
  const segments = (data[0] & 7) + 1;
  if (segments > MAX_SEGMENTS || seg >= segments) return null;
  let corrected = 0;
  for (let i = 0; i < data.length; i++) if (data[i] !== block[i]) corrected++;
  return { index, segments, seg, chunk: data.slice(SEGMENT_HEADER, SEGMENT_HEADER + CHUNK_BYTES), corrected };
}

/** header | author "\n" text | crc | filler -> message fields, or null if anything is off. */
function parse(data: number[]) {
  const bytes = Uint8Array.from(data);
  let body: string;
  try {
    body = decodeText(bytes.subarray(HEADER_BYTES));
  } catch {
    return null;
  }
  const split = body.indexOf('\n');
  if (split < 0) return null;
  const author = body.slice(0, split);
  const text = body.slice(split + 1);
  // The encoder is deterministic, so re-encoding recovers the body's length.
  const end = HEADER_BYTES + encodeText(body).length;
  if (end + CRC_BYTES > data.length) return null;
  const crc = crc16(bytes.subarray(0, end));
  if (data[end] !== crc >> 8 || data[end + 1] !== (crc & 0xff)) return null;
  for (let i = end + CRC_BYTES; i < data.length; i++) if (data[i] !== filler(i - end - CRC_BYTES)) return null;
  return {
    thread: (data[0] << 8) | data[1],
    index: data[2],
    parent: data[3] === NO_PARENT ? -1 : data[3],
    total: data[4],
    author,
    text,
  };
}

/** Reads every spiral it can find in one image, in no particular order. Callers should downscale large photos first. */
export function decodeImage(
  rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, opts: FrameOptions = {},
): DecodedMessage[] {
  return new Reader().addFrame(rgba, width, height, opts).messages;
}
