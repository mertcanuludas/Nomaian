// Image preparation and the markers: pairs of fused hexagonal rings written into the chain. On a binarised
// image a ring is a small closed hole in the ink. The writing's own rings, fused pairs among them, are
// smaller and unlike each other in size, so a pair of two big, alike holes side by side is taken for a
// marker, at any rotation and scale; the line through the two holes gives the local direction of the
// writing. The few such pairs the writing still makes are weeded out when markers are linked into chains.

import { STROKE, ZIG_A } from './layout';

export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return { data, width, height };
}

/** Adaptive threshold. Returns 1 for ink. `darkInk` selects the polarity. */
export function binarize(g: Gray, window: number, darkInk: boolean): Uint8Array {
  const { width: w, height: h, data } = g;
  const integ = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x];
      integ[(y + 1) * (w + 1) + x + 1] = integ[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  const r = Math.max(4, Math.round(window / 2));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum =
        integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = data[y * w + x];
      const margin = Math.max(6, mean * 0.06);
      out[y * w + x] = darkInk ? (v < mean - margin ? 1 : 0) : v > mean + margin ? 1 : 0;
    }
  }
  return out;
}

/**
 * Block min/max threshold (as in jsQR): each `block`-sized cell gets the midpoint
 * of its range, then thresholds are averaged over a 5x5 neighbourhood of cells.
 * Cells with almost no contrast borrow from their neighbours, so the inside of a
 * solid pupil still reads as ink. Much more tolerant of blur than a mean filter.
 */
export function binarizeBlocks(g: Gray, block: number, darkInk: boolean): Uint8Array {
  const { width: w, height: h, data } = g;
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);
  const mid = new Float32Array(bw * bh).fill(NaN);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let lo = 255;
      let hi = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++)
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) {
          const v = data[y * w + x];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi - lo > 24) mid[by * bw + bx] = (lo + hi) / 2;
    }
  const thr = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      let s = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = bx + dx;
          const y = by + dy;
          if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
          const m = mid[y * bw + x];
          if (!Number.isNaN(m)) {
            s += m;
            n++;
          }
        }
      thr[by * bw + bx] = n ? s / n : darkInk ? -1 : 256;
    }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = thr[Math.floor(y / block) * bw + Math.floor(x / block)];
      const v = data[y * w + x];
      out[y * w + x] = darkInk ? (v < t ? 1 : 0) : v > t ? 1 : 0;
    }
  return out;
}


/** A hole: a patch of background enclosed by ink. Second moments give its shape. */
interface Hole {
  x: number;
  y: number;
  area: number;
  sxx: number;
  syy: number;
  sxy: number;
}

/** Smallest hole worth looking at, in pixels; rings this small are too blurred to read anyway. */
const MIN_HOLE = 12;

/** Enclosed background patches between MIN_HOLE pixels and `maxArea`, with a roughly round or hexagonal shape. */
function findHoles(bin: Uint8Array, w: number, h: number, maxArea: number): Hole[] {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const holes: Hole[] = [];
  for (let start = 0; start < w * h; start++) {
    if (bin[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let area = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let open = false;
    while (sp) {
      const i = stack[--sp];
      const x = i % w;
      const y = (i - x) / w;
      area++;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        open = true;
        continue;
      }
      if (!bin[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (stack[sp++] = i - 1);
      if (!bin[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (stack[sp++] = i + 1);
      if (!bin[i - w] && !seen[i - w]) (seen[i - w] = 1), (stack[sp++] = i - w);
      if (!bin[i + w] && !seen[i + w]) (seen[i + w] = 1), (stack[sp++] = i + w);
    }
    if (open || area < MIN_HOLE || area > maxArea) continue;
    const x = sx / area;
    const y = sy / area;
    const hole = { x, y, area, sxx: sxx / area - x * x, syy: syy / area - y * y, sxy: sxy / area - x * y };
    // An ellipse fills exactly 4 pi sqrt(det) of its second moments (a hexagon nearly so); slivers, crescents
    // and long gaps between strokes do not.
    const det = hole.sxx * hole.syy - hole.sxy * hole.sxy;
    if (det <= 0) continue;
    const fill = area / (4 * Math.PI * Math.sqrt(det));
    const tr = hole.sxx + hole.syy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const elong = Math.sqrt((tr / 2 + disc) / Math.max(1e-9, tr / 2 - disc));
    if (fill < 0.75 || fill > 1.25 || elong > 2.5) continue;
    holes.push(hole);
  }
  return holes;
}

export interface Marker {
  x: number;
  y: number;
  /** unit vector along the writing; which way it reads is not known */
  tx: number;
  ty: number;
  /** pixels per glyph unit along the writing */
  scale: number;
  /**
   * Where a step across the writing lands in the image, relative to a step along it: `skew` along t and
   * `across` along t turned by +90 degrees. A head-on view gives 0 and 1; a slanted one squashes and shears.
   */
  skew: number;
  across: number;
}

/**
 * The local distortion, from a ring's second moments (sxx, syy, sxy) and the image direction t of the
 * writing. A ring is round, so its moments are S S^T up to scale, for S = Sigma^(1/2) the local linear map
 * up to a rotation R. R is pinned down by S R t0 lying along t; a step across, R n0 = (R t0) turned +90
 * degrees, then lands at S R n0. Returns it in units of S R t0, as [skew, across].
 */
function normalOf(tx: number, ty: number, sxx: number, syy: number, sxy: number): [number, number] {
  const det = sxx * syy - sxy * sxy;
  const sq = Math.sqrt(Math.max(det, 1e-12));
  const norm = Math.sqrt(sxx + syy + 2 * sq);
  // S = (Sigma + sqrt(det) I) / sqrt(tr + 2 sqrt(det)), symmetric.
  const a = (sxx + sq) / norm;
  const b = sxy / norm;
  const c = (syy + sq) / norm;
  const sdet = a * c - b * b;
  // e = S^-1 t, normalised: the template direction R t0.
  let ex = (c * tx - b * ty) / sdet;
  let ey = (-b * tx + a * ty) / sdet;
  const el = Math.hypot(ex, ey);
  ex /= el;
  ey /= el;
  const alongLen = Math.hypot(a * ex + b * ey, b * ex + c * ey);
  // S applied to e turned +90 degrees, relative to S e.
  const nx = (a * -ey + b * ex) / alongLen;
  const ny = (b * -ey + c * ex) / alongLen;
  const skew = nx * tx + ny * ty;
  const across = nx * -ty + ny * tx;
  return [Math.max(-0.6, Math.min(0.6, skew)), Math.max(0.45, Math.min(1.5, across))];
}

/** Centre distance of a marker's two rings over a ring's equivalent radius, as drawn. */
const INNER = ZIG_A - STROKE / 2;
const RING_R = Math.sqrt((2 * Math.sqrt(3) * INNER * INNER) / Math.PI);
export const PAIR_RATIO = (2 * ZIG_A) / RING_R;

/** Markers found in a binarised image. More than `max` holes means clutter or noise: none are returned. */
export function findMarkers(bin: Uint8Array, w: number, h: number, max = 3000): Marker[] {
  const holes = findHoles(bin, w, h, (w * h) / 100);
  if (holes.length > max) return [];
  holes.sort((a, b) => a.x - b.x);
  const pairs: Array<{ a: Hole; b: Hole; cost: number }> = [];
  for (let i = 0; i < holes.length; i++) {
    const a = holes[i];
    const ra = Math.sqrt(a.area / Math.PI);
    for (let j = i + 1; j < holes.length; j++) {
      const b = holes[j];
      if (b.x - a.x > 4 * ra) break;
      const rb = Math.sqrt(b.area / Math.PI);
      const ar = a.area > b.area ? a.area / b.area : b.area / a.area;
      // A marker's rings are alike; fused rings in the writing differ in size.
      if (ar > 1.5) continue;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      // Ink thickens in photos, which shrinks the holes: allow for rings that look smaller than drawn.
      const ratio = d / ((ra + rb) / 2);
      if (ratio < 0.7 * PAIR_RATIO || ratio > 1.65 * PAIR_RATIO) continue;
      // The shared edge lies between them.
      const mx = Math.round((a.x + b.x) / 2);
      const my = Math.round((a.y + b.y) / 2);
      const k = my * w + mx;
      if (!(bin[k] || bin[k - 1] || bin[k + 1] || bin[k - w] || bin[k + w])) continue;
      pairs.push({ a, b, cost: Math.abs(Math.log(ratio / (1.15 * PAIR_RATIO))) + Math.log(ar) });
    }
  }
  pairs.sort((p, q) => p.cost - q.cost);
  const used = new Set<Hole>();
  const out: Marker[] = [];
  for (const { a, b } of pairs) {
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const tx = (b.x - a.x) / d;
    const ty = (b.y - a.y) / d;
    const [skew, across] = normalOf(tx, ty, (a.sxx + b.sxx) / 2, (a.syy + b.syy) / 2, (a.sxy + b.sxy) / 2);
    out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, tx, ty, scale: d / (2 * ZIG_A), skew, across });
  }
  return out;
}
