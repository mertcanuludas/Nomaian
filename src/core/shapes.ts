// The strokes of the writing, in a line's local coordinates (s along it, v across it), and the templates the
// decoder matches them against.
//
// Every vertex of the chain carries one of 16 groups on its outer side, worth 4 bits: rings (squares,
// pentagons, hexagons) sitting right on the chain or on a short bond, rings fused to each other, forks,
// stubs and branches, all at about the size of a bond, like a molecule drawing. A group is drawn in vertex
// coordinates: u along the line (in reading direction), w away from it, both in bonds.

import {
  BOND, decoyVertexS, decoyVertexV, GAP_END, GAP_START, GAP_SYMBOLS, gapVertex, GAP_VERTICES, Sequence, STROKE, vertexInGap,
  vertexSide, ZIG_A,
} from './layout';

export type Pt = readonly [number, number];
type Lines = Pt[][];

/** Regular polygon with `n` corners and sides `side`, one corner at (0, base), pointing away from the line. */
function ring(n: number, side: number, base: number): Pt[] {
  const R = side / (2 * Math.sin(Math.PI / n));
  const cw = base + R;
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / n;
    return [R * Math.cos(a), cw + R * Math.sin(a)] as Pt;
  });
}

/** Regular polygon with `n` corners built on the edge p -> q, on its left (away from the line for p left of q). */
function edgeRing(p: Pt, q: Pt, n: number): Pt[] {
  const side = Math.hypot(q[0] - p[0], q[1] - p[1]);
  let dir = Math.atan2(q[1] - p[1], q[0] - p[0]);
  const pts: Pt[] = [p, q];
  for (let k = 2; k <= n; k++) {
    dir += (2 * Math.PI) / n;
    const [x, y] = pts[pts.length - 1];
    pts.push([x + side * Math.cos(dir), y + side * Math.sin(dir)]);
  }
  pts[n] = p;
  return pts;
}

const stem = (to: number, from = 0): Pt[] => [[0, from], [0, to]];
/** A bond from the stem at height `at`, `len` long, at 60 degrees from it to the left (-1) or right (+1). */
const arm = (at: number, len: number, side: number): Pt[] => [[0, at], [side * len * Math.sin(Math.PI / 3), at + len / 2]];

/** Ring side. */
const SIDE = 0.78;
const PENT = ring(5, 0.8, 0);
const SMALL_PENT = ring(5, 0.66, 0);
/** A branch that bends twice, like a short chain: up, off to one side, up again. */
const kinked = (side: number): Pt[] => [[0, 0], [0, 0.85], [side * 0.7, 1.25], [side * 0.7, 2.05]];

/**
 * The 16 groups, by value. 4 and 11, and 12 and 13, are mirror images, which is what a gap read backwards
 * turns them into; the others are symmetric.
 */
const GROUPS: Lines[] = [
  [],
  [stem(1.05)],
  [stem(0.75), [arm(0.75, 0.78, -1)[1], [0, 0.75], arm(0.75, 0.78, 1)[1]]],
  [ring(4, 0.85, 0)],
  [kinked(-1)],
  [PENT],
  [ring(4, 0.85, 0), stem(1.95, 0.85 * Math.SQRT2)],
  [ring(6, SIDE, 0)],
  [stem(0.5), ring(6, 0.72, 0.5)],
  [ring(6, SIDE, 0), stem(2.25, 2 * SIDE)],
  [PENT, edgeRing(PENT[3], PENT[2], 4)],
  [kinked(1)],
  [stem(1.05), arm(0.55, 0.8, -1)],
  [stem(1.05), arm(0.55, 0.8, 1)],
  [SMALL_PENT, edgeRing(SMALL_PENT[3], SMALL_PENT[2], 6)],
  [stem(0.55), ring(4, 0.8, 0.55)],
];

/** Value of a group seen from the other end of the line. */
const PAIRS: Record<number, number> = { 4: 11, 11: 4, 12: 13, 13: 12 };
const FLIP = Array.from({ length: 16 }, (_, v) => PAIRS[v] ?? v);
export const flipValue = (value: number) => FLIP[value];

/** Polylines of the group for a 4-bit value, in bonds. */
export function featureLines(value: number): Lines {
  return GROUPS[value];
}

/** A polyline in a line's local coordinates. */
export type Stroke = Array<[number, number]>;

/** Draws polylines given in vertex coordinates at the vertex (s, v); `out` is +1 when they point to +v. */
function linesAt(lines: Lines, s: number, v: number, out: number, into: Stroke[]) {
  for (const line of lines) into.push(line.map(([u, w]) => [s + u * BOND, v + out * w * BOND]));
}

/** `value` at the vertex (s, v), on its outer side. */
function vertexStrokes(value: number, s: number, v: number, into: Stroke[], out = v > 0 ? 1 : -1) {
  linesAt(featureLines(value), s, v, out, into);
}

/** A random value for decorative vertices. */
const anyValue = (rnd: () => number) => Math.floor(rnd() * 16);

/** The two fused hexagons of a marker centred at `m`: each as a closed polyline. */
export function markerStrokes(m: number): Stroke[] {
  const rings = [-1, 1].map((side) => {
    const c = m + side * ZIG_A;
    return Array.from({ length: 7 }, (_, k) => {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      return [c + BOND * Math.cos(a), BOND * Math.sin(a)] as [number, number];
    });
  });
  // The chain joins at the lower left and upper right corners. A short bond on the two opposite corners
  // makes each ring symmetric about the line again, so a blurred ring does not look sheared, which the
  // decoder would take for a slanted view.
  const stub = 0.5 * BOND;
  const spurs: Stroke[] = [
    [[m - 2 * ZIG_A, BOND / 2], [m - 2 * ZIG_A - stub * Math.cos(Math.PI / 6), BOND / 2 + stub / 2]],
    [[m + 2 * ZIG_A, -BOND / 2], [m + 2 * ZIG_A + stub * Math.cos(Math.PI / 6), -BOND / 2 - stub / 2]],
  ];
  return [...rings, ...spurs];
}

/** An irregular height for a decorative vertex, like the data vertices'. */
const anyHeight = (rnd: () => number) => (0.15 + 0.35 * rnd()) * BOND;

/**
 * All strokes of a spiral, with `values` (4 bits per data vertex, in reading order) written in its gaps.
 * The vertices before the first marker and after the last are decoration, picked by `rnd`; so is the eye,
 * the first `eye` of the line (arc positions -eye..0), whose groups all point out of the curl (+v) so that
 * they do not pile up inside it.
 */
export function spiralStrokes(seq: Sequence, values: ArrayLike<number>, rnd: () => number, eye = 0): Stroke[] {
  const out: Stroke[] = [];
  const { markers } = seq;
  const at = (m: number, [s, v]: [number, number]): [number, number] => [m + s, v];

  // Lead: from the eye into the first marker, alternating so the last vertex sits below the line.
  const lead: Stroke = [];
  const eyeVerts: DecorVertex[] = [];
  for (let k = Math.floor(eye / ZIG_A); k >= 1; k--) {
    const v = (k % 2 ? 1 : -1) * anyHeight(rnd);
    const s = -k * ZIG_A + (rnd() - 0.5) * 0.15 * BOND;
    if (lead.length && rnd() < 0.4) lead.push(kinkPoint(lead[lead.length - 1], [s, v]));
    lead.push([s, v]);
    eyeVerts.push({ s, v, out: v > 0 ? 1 : -1, free: v > 0 && k > 2 });
  }
  // Turns of the eye lie close together: it gets only small groups, so they do not run into each other.
  decorate(eyeVerts, rnd, out, true);
  for (let k = 0; k < 3; k++) {
    const s = markers[0] - (5 - k) * ZIG_A;
    const v = (k % 2 ? 1 : -1) * anyHeight(rnd);
    lead.push([s, v]);
    vertexStrokes(k ? anyValue(rnd) : 1, s, v, out);
  }
  lead.push(at(markers[0], [-GAP_START[0], -GAP_START[1]]));
  out.push(lead);

  for (let g = 0; g < markers.length; g++) {
    out.push(...markerStrokes(markers[g]));
    const chain: Stroke = [at(markers[g], GAP_START)];
    if (g + 1 < markers.length) {
      for (let j = 0; j < GAP_VERTICES; j++) {
        const [s, v] = gapVertex(seq, g, j);
        // A bond whose bit is set is broken in the middle: it bends out to one side and back (see KINK).
        if (j && values[g * GAP_SYMBOLS + GAP_VERTICES + j - 1]) chain.push(kinkPoint(chain[chain.length - 1], [s, v]));
        chain.push([s, v]);
        vertexStrokes(values[g * GAP_SYMBOLS + j], s, v, out, vertexSide(j));
      }
      chain.push(at(markers[g], GAP_END));
    } else {
      // Tail, ending in a bare bond.
      for (let j = 0; j < 4; j++) {
        const [s, v] = gapVertex(seq, g, j);
        chain.push([s, v]);
        if (j < 2) vertexStrokes(anyValue(rnd), s, v, out, vertexSide(j));
      }
    }
    out.push(chain);
  }
  return out;
}

/** How far, in bonds, a broken bond's middle is pushed out to the left of its direction. */
export const KINK = 0.38;

/** The middle of a broken bond from `a` to `b`: pushed out to the left of the way it runs. */
export function kinkPoint(a: readonly [number, number], b: readonly [number, number]): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [(a[0] + b[0]) / 2 - (dy / l) * KINK * BOND, (a[1] + b[1]) / 2 + (dx / l) * KINK * BOND];
}

/** Groups that stay close to the chain. */
const SMALL = [0, 1, 2, 3, 5, 12, 13];

/** A vertex of decorative writing: where it is, which side its group goes, and whether it may have one. */
interface DecorVertex {
  s: number;
  v: number;
  out: number;
  free: boolean;
}

/**
 * Decoration for a run of vertices: mostly a random group at each free vertex, but now and then a strand
 * that branches off and runs alongside the chain for a few bonds, often joining it again further on, as
 * in the reference drawings. A strand takes the place of the groups it passes over.
 */
function decorate(verts: DecorVertex[], rnd: () => number, out: Stroke[], small = false) {
  const taken = new Set<number>();
  verts.forEach((p, i) => {
    if (!p.free || taken.has(i)) return;
    // The free vertices further on, on the same side, that a strand would pass over.
    const ahead: number[] = [];
    for (let k = i + 1; k < verts.length && ahead.length < 4; k++) {
      if (verts[k].out !== p.out) continue;
      if (!verts[k].free) break;
      ahead.push(k);
    }
    if (!small && ahead.length >= 2 && rnd() < 0.22) {
      const n = Math.min(ahead.length, 2 + Math.floor(rnd() * 3));
      const end = verts[ahead[n - 1]];
      const base = (s: number) => p.v + ((end.v - p.v) * (s - p.s)) / (end.s - p.s || 1);
      const strand: Stroke = [[p.s, p.v], [p.s, p.v + p.out * 0.95 * BOND]];
      const steps = Math.max(2, Math.round((end.s - p.s) / ZIG_A));
      for (let k = 1; k <= steps; k++) {
        const s = p.s + ((end.s - p.s) * k) / steps;
        const lift = (k % 2 ? 1.45 : 0.95) * BOND + (rnd() - 0.5) * 0.2 * BOND;
        strand.push([s, base(s) + p.out * lift]);
        // Small groups on the strand's own outer side.
        if (k % 2 && k < steps && rnd() < 0.5) linesAt(featureLines([1, 3, 5, 7][Math.floor(rnd() * 4)]), s, base(s) + p.out * lift, p.out, out);
      }
      // Usually the strand comes back down onto the chain, closing a long loop; otherwise it ends free.
      if (rnd() < 0.6) strand.push([end.s, end.v]);
      out.push(strand);
      for (let k = 0; k < n; k++) taken.add(ahead[k]);
      return;
    }
    vertexStrokes(small ? SMALL[Math.floor(rnd() * SMALL.length)] : anyValue(rnd), p.s, p.v, out, p.out);
  });
}

/**
 * Decoy writing along a stalk of length `len` (no markers), from its p0 end: an irregular chain all the
 * way, with groups and strands up to `dressed` except at the vertices in `bare` (see LaidOut.bare).
 */
export function decoyStrokes(len: number, rnd: () => number, bare: readonly number[] = [], dressed = len): Stroke[] {
  const out: Stroke[] = [];
  const chain: Stroke = [[0, 0]];
  const verts: DecorVertex[] = [];
  for (let j = 0, s = decoyVertexS(0); s < len - 0.5 * ZIG_A; j++, s = decoyVertexS(j)) {
    const out = Math.sign(decoyVertexV(j));
    const v = out * anyHeight(rnd);
    if (j && rnd() < 0.4) chain.push(kinkPoint(chain[chain.length - 1], [s, v]));
    chain.push([s, v]);
    verts.push({ s, v, out, free: s <= dressed && !bare.includes(j) });
  }
  // The chain runs right into the point where the stalk meets its parent.
  chain.push([len, 0]);
  out.push(chain);
  decorate(verts, rnd, out);
  return out;
}

// ---------- decoding ----------

// Sampling grid used by the decoder at a vertex, in vertex coordinates (bonds). The first row sits on the
// vertex, so a bare vertex still has a shape to match.
export const GRID_U = Array.from({ length: 9 }, (_, i) => -0.8 + (1.6 * (i + 0.5)) / 9);
export const GRID_W = Array.from({ length: 12 }, (_, i) => i * 0.22);

function distToSegment(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

/** The two bonds of the chain at vertex `j` of a gap, in its vertex coordinates (bonds). */
function chainAt(j: number): Lines {
  const [s, v] = vertexInGap(j);
  const out = vertexSide(j);
  const local = ([ps, pv]: [number, number]): Pt => [(ps - s) / BOND, (out * (pv - v)) / BOND];
  const prev = j ? vertexInGap(j - 1) : GAP_START;
  const next = j + 1 < GAP_VERTICES ? vertexInGap(j + 1) : GAP_END;
  return [[[0, 0], local(prev)], [[0, 0], local(next)]];
}

/** Distance (glyph units) from a point given in bonds to the nearest ink of some lines. */
function inkDistance(lines: Lines, u: number, w: number): number {
  let d = Infinity;
  for (const line of lines)
    for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, distToSegment(u, w, line[i], line[i + 1]));
  return Math.max(0, d * BOND - STROKE / 2);
}

/** Zero-mean, unit-norm vector. */
function normalize(v: ArrayLike<number>): Float32Array {
  let mean = 0;
  for (let i = 0; i < v.length; i++) mean += v[i];
  mean /= v.length;
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i] - mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/**
 * Expected ink over the grid for each value at each vertex of a gap (the chain bonds differ from vertex to
 * vertex), blurred a little. Blurrier templates for soft or small images were tried and read worse.
 */
export const TEMPLATES: Float32Array[][] = Array.from({ length: GAP_VERTICES }, (_, j) => {
  const chain = chainAt(j);
  return Array.from({ length: 16 }, (_, value) => {
    const blur = 1.3;
    const lines = [...featureLines(value), ...chain];
    const v: number[] = [];
    for (const gu of GRID_U)
      for (const gw of GRID_W) {
        const d = inkDistance(lines, gu, gw);
        v.push(Math.exp(-(d * d) / (2 * blur * blur)));
      }
    return normalize(v);
  });
});

/** Correlation of grid samples (ink positive) at vertex `j` with each value's template. */
export function valueScores(samples: ArrayLike<number>, j: number): Float32Array {
  const z = normalize(samples);
  const out = new Float32Array(16);
  for (let value = 0; value < 16; value++) {
    const t = TEMPLATES[j][value];
    let s = 0;
    for (let i = 0; i < t.length; i++) s += t[i] * z[i];
    out[value] = s;
  }
  return out;
}

/**
 * The emptiest point straight across the line from vertex `j` of a gap, as an offset across the line for a
 * vertex on the + side: the point whose nearest possible ink (the chain, and every group the vertices on
 * near it could carry) is furthest away, and how far that is. The decoder checks there is no ink there.
 */
export function hollowAt(j: number): [number, number] {
  const [s, v] = vertexInGap(j);
  const side = vertexSide(j);
  // Everything in the gap's coordinates, flipped so that vertex j is on the + side.
  const pt = ([ps, pv]: [number, number]): Pt => [ps, side * pv];
  const ink: Lines = [[GAP_START, ...Array.from({ length: GAP_VERTICES }, (_, n) => vertexInGap(n)), GAP_END].map(pt)];
  // Broken bonds, bent either way (a gap read backwards bends them the other way).
  for (let n = 0; n + 1 < GAP_VERTICES; n++) {
    const a = vertexInGap(n);
    const b = vertexInGap(n + 1);
    const k = kinkPoint(a, b);
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    ink.push([a, k, b].map(pt), [a, [2 * mid[0] - k[0], 2 * mid[1] - k[1]] as [number, number], b].map(pt));
  }
  for (let n = j - 4; n <= j + 4; n++) {
    if (n === j) continue;
    if (n < 0 || n >= GAP_VERTICES) continue;
    const [ns, nv] = vertexInGap(n);
    for (let value = 1; value < 16; value++)
      for (const line of featureLines(value)) ink.push(line.map(([u, w]) => pt([ns + u * BOND, nv + vertexSide(n) * w * BOND])));
  }
  let best = 0;
  let clear = -1;
  for (let w = side * v; w > side * v - 2.5 * BOND; w -= 0.1) {
    let d = Infinity;
    for (const line of ink)
      for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, distToSegment(s, w, line[i], line[i + 1]));
    if (d > clear) {
      clear = d;
      best = w;
    }
  }
  return [side * best, clear];
}
