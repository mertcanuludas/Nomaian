// Canonical geometry of a Nomaian conversation. Units are arbitrary ("glyph units").
//
// Writing looks like a skeletal molecule formula: an irregular zigzag chain that wanders about the
// spiral's line, a group (ring, fused rings, fork, stub or branch) hanging off each vertex on its outer
// side, its bonds straight or broken in the middle, and a pair of fused hexagons (the marker) every
// GAP_VERTICES vertices. Every message is written on its own spiral, starting at the eye and running
// outwards. Spirals come in about the same size whatever their message; a short message is written over and
// over until its spiral's line is full.
//
// The markers are the biggest closed rings, so the decoder can find them anywhere; the line through two
// fused rings gives the local direction of the writing. The stretch between two markers (a gap) holds a
// 4-bit group per vertex and a bit per bond. A message is cut into segments of GAPS_PER_SEGMENT gaps, each
// a Reed-Solomon codeword that says which segment of which message it is, so a camera can read a spiral
// piece by piece.
//
// A reply is a spiral placed beside its parent, its outer end joined to one of the parent's markers by a
// stalk, which carries decoy writing (no markers) so the whole reads as one piece.

/** Bond length. */
export const BOND = 9;
export const STROKE = 1.6;
/** Zigzag: advance along the line per vertex, and how far vertices sit off it. */
export const ZIG_A = BOND * Math.cos(Math.PI / 6);
export const ZIG_H = BOND / 4;
/** How far ink may reach from the line, on either side. */
export const BAND = 3.3 * BOND;

export const GAP_VERTICES = 16;
export const BITS_PER_VERTEX = 4;
/** Marker centre to marker centre, along the line. */
export const GAP_LEN = (GAP_VERTICES + 5) * ZIG_A;

/**
 * Each segment: one header byte, then its chunk of the message, then parity. The header holds the low two
 * bits of the message's index (bits 7-6), the segment's place (5-3) and the message's segment count less
 * one (2-0); the reader tells apart messages that share those two bits by their CRC.
 */
export const GAPS_PER_SEGMENT = 3;
export const SEGMENT_HEADER = 1;
export const CHUNK_BYTES = 20;
export const PARITY_BYTES = 8;
export const SEGMENT_BYTES = SEGMENT_HEADER + CHUNK_BYTES + PARITY_BYTES;

/**
 * Besides its vertices' groups, a gap writes one bit in each bond between its data vertices: straight or
 * broken in the middle. A gap's symbols are its vertices' values, then its bonds' bits.
 */
export const GAP_BONDS = GAP_VERTICES - 1;
export const GAP_SYMBOLS = GAP_VERTICES + GAP_BONDS;
const GAP_BITS = GAP_VERTICES * BITS_PER_VERTEX + GAP_BONDS;
export const SEGMENT_SYMBOLS = GAPS_PER_SEGMENT * GAP_SYMBOLS;
/** Bits a segment's gaps hold; those past the codeword are left 0 (before whitening). */
export const SEGMENT_BITS = GAPS_PER_SEGMENT * GAP_BITS;
if (SEGMENT_BYTES * 8 > SEGMENT_BITS) throw new Error('segment does not fit its gaps');

/** Where bit `k` of a segment is written: which symbol, and which bit of it (0 = least significant). */
export function bitSymbol(k: number): [number, number] {
  const g = Math.floor(k / GAP_BITS);
  const r = k % GAP_BITS;
  if (r < GAP_VERTICES * BITS_PER_VERTEX)
    return [g * GAP_SYMBOLS + Math.floor(r / BITS_PER_VERTEX), BITS_PER_VERTEX - 1 - (r % BITS_PER_VERTEX)];
  return [g * GAP_SYMBOLS + GAP_VERTICES + r - GAP_VERTICES * BITS_PER_VERTEX, 0];
}
/** Payload limit per message: header, text and CRC. */
export const DATA_BYTES = 100;
/** Segments the longest message takes; the header has room for up to 8. */
export const MAX_SEGMENTS = Math.ceil(DATA_BYTES / CHUNK_BYTES);
if (MAX_SEGMENTS > 8) throw new Error('segment count does not fit the segment header');

/** Decorative vertices before the first marker (in the eye) and after the last. */
const LEAD_VERTICES = 3;
const TAIL_VERTICES = 3;
const DS = 0.5;

/**
 * How far, per unit of the parent's scale, a stalk's decoy writing keeps from its parent's line where it
 * branches off: clear of the parent's band, whose data reaches about 2.8 bonds out.
 */
export const NECK = 2.8 * BOND + ZIG_H + STROKE;
/** Shortest stalk between a reply's outer end and its parent's port. */
const STALK = 70;
/** A reply branches off its parent at about this angle to the parent's line, outwards. */
const BRANCH = 1.05;
/** Spirals are drawn at sizes between these, writing included. */
export const MIN_SCALE = 0.97;
export const MAX_SCALE = 1.03;
/** Ink is checked for collisions at points this far apart along each line... */
const INK_STEP = 12;
/** ...each standing for a disk this big (the band of writing around the line)... */
const INK_R = (BAND + STROKE) * MAX_SCALE;
/** ...and disks of different spirals or stalks must stay this far apart. */
const CLEARANCE = 2 * INK_R + 12;

/** Where things sit along the arc of a spiral with `segments` segments. */
export interface Sequence {
  segments: number;
  /** arc length */
  len: number;
  /** arc position of each marker centre; gap g runs from markers[g] to markers[g + 1] */
  markers: number[];
  /** markers replies may attach to (as many as PORTS at least, repeating if need be), outermost first */
  ports: number[];
}

/** Replies a single message can take; each grows from a different marker, no two next to each other. */
export const PORTS = 3;

const sequences = new Map<number, Sequence>();

export function sequence(segments: number): Sequence {
  let seq = sequences.get(segments);
  if (seq) return seq;
  const gaps = segments * GAPS_PER_SEGMENT;
  const m0 = (LEAD_VERTICES + 2) * ZIG_A;
  const markers = Array.from({ length: gaps + 1 }, (_, i) => m0 + i * GAP_LEN);
  const last = markers[gaps];
  // A reply may grow from any marker but the very end, where this spiral's own stalk (if it is a reply)
  // leaves, and the first, in the eye's curl. A short spiral lists some twice, so it can still take PORTS.
  const ports = Array.from({ length: Math.max(PORTS, gaps - 1) }, (_, k) => gaps - 1 - (k % (gaps - 1)));
  seq = { segments, len: last + (TAIL_VERTICES + 3) * ZIG_A, markers, ports };
  sequences.set(segments, seq);
  return seq;
}

/**
 * The chain between two markers is not a regular zigzag: every vertex sits a little off its regular place,
 * along the line and away from it, by a fixed table, so the line looks irregular while the decoder still
 * knows where each vertex is. The table reads the same from either end (shifts mirrored, heights equal),
 * so a gap seen backwards has the same shape as one seen forwards.
 */
const HALF_DS = [0.08, -0.06, 0.03, 0.08, -0.07, 0, 0.06, -0.04];
const HALF_H = [0.25, 0.45, 0.15, 0.4, 0.3, 0.5, 0.2, 0.35];
const VERTEX_DS = Array.from({ length: GAP_VERTICES }, (_, j) => (j < 8 ? HALF_DS[j] : -HALF_DS[GAP_VERTICES - 1 - j]) * BOND);
const VERTEX_H = Array.from({ length: GAP_VERTICES }, (_, j) => (j < 8 ? HALF_H[j] : HALF_H[GAP_VERTICES - 1 - j]) * BOND);

/**
 * The chain also wanders from side to side about the spiral's line, by up to about a bond and a half,
 * coming back onto it at the markers. Seen from the other end the wander is the same, mirrored (a sum of
 * sines over the gap, each odd about its middle), so it too reads the same either way.
 */
export const wanderAt = (s: number) => {
  const t = s / GAP_LEN;
  return BOND * (0.85 * Math.sin(2 * Math.PI * t) - 0.5 * Math.sin(4 * Math.PI * t) + 0.3 * Math.sin(6 * Math.PI * t));
};

/** Which side of the chain vertex `j` of a gap points to, and so the side its group hangs on. */
export const vertexSide = (j: number) => (j % 2 ? -1 : 1);

/** Vertex `j` of a gap, relative to the gap's first marker: arc position, offset across the line. */
export function vertexInGap(j: number): [number, number] {
  const s = (3 + j) * ZIG_A + VERTEX_DS[j];
  return [s, vertexSide(j) * VERTEX_H[j] + wanderAt(s)];
}

/** Vertex `j` of gap `g` (0-based in reading order): arc position, offset across the line. */
export function gapVertex(seq: Sequence, g: number, j: number): [number, number] {
  const [s, v] = vertexInGap(j);
  return [seq.markers[g] + s, v];
}

/** Where the chain leaves a marker and enters the next, relative to the first marker of a gap. */
export const GAP_START: [number, number] = [2 * ZIG_A, BOND / 2];
export const GAP_END: [number, number] = [GAP_LEN - 2 * ZIG_A, -BOND / 2];

/**
 * Spiral shapes: a curled eye that sweeps out into a long tail, some curling in more than others. Each is a
 * logarithmic spiral r = r0 e^(b t) that makes `turns` turns whatever the length of its message, so a short
 * message curls as much as a long one, just smaller.
 */
const VARIANT_SHAPES = [
  // From an open sweep that does not come round even once to a curl of over two turns; the looser ones
  // start from a wider eye, as the old shapes did.
  { turns: 0.6, r0: 56 },
  { turns: 0.92, r0: 46 },
  { turns: 1.24, r0: 38 },
  { turns: 1.56, r0: 31 },
  { turns: 1.88, r0: 25 },
  { turns: 2.2, r0: 20 },
];
export const SHAPES = VARIANT_SHAPES.length;
/**
 * The eye is too tightly curled for the decoder to follow from one marker to the next, so it carries
 * decorative writing only; the message starts where the line has opened out to this radius.
 */
const DATA_RADIUS = 120;
/** Room between neighbouring turns: inside the eye, and where the message's first turn passes the eye. */
const EYE_GAP = 30;
const DATA_GAP = 55;

/**
 * One spiral shape, sampled every DS along the arc from the centre of the eye, long enough for the longest
 * message. Arc positions s used elsewhere start where the message does: the eye runs from -lead to 0.
 */
export interface Variant {
  /** radius where the line starts, in the middle of the eye */
  r0: number;
  /** arc length of the eye, before the message */
  lead: number;
  px: Float64Array;
  py: Float64Array;
  /** unit normal, left of travel (centre -> outer end), which points out of the curl */
  nx: Float64Array;
  ny: Float64Array;
  /** furthest the line has got from the centre of the curl (the origin), by sample */
  rmax: Float64Array;
}

function buildVariant({ turns, r0 }: { turns: number; r0: number }, segments: number): Variant {
  const len = sequence(segments).len;
  // Arc of r0 e^(b t) from t = 0 to T, in closed form.
  const arc = (b: number, T: number) => (r0 * Math.sqrt(1 + b * b) * (Math.exp(b * T) - 1)) / b;
  // The message runs from DATA_RADIUS outwards, so it ends at this radius.
  const rEnd = (b: number) => DATA_RADIUS + (len * b) / Math.sqrt(1 + b * b);
  // A line too short for all the turns, with room between them, makes as many as it can.
  let b = 0;
  for (let want = turns; ; want -= 0.05) {
    let lo = 1e-4;
    let hi = 2;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      if (Math.log(rEnd(mid) / r0) > 2 * Math.PI * want * mid) lo = mid;
      else hi = mid;
    }
    b = hi;
    const grow = Math.exp(2 * Math.PI * b);
    if ((r0 * (grow - 1) >= EYE_GAP && (DATA_RADIUS / grow) * (grow - 1) >= DATA_GAP) || want < 0.6) break;
  }
  const lead = r0 >= DATA_RADIUS ? 0 : arc(b, Math.log(DATA_RADIUS / r0) / b);
  const want = lead + len;
  const T = Math.log(1 + (want * b) / (r0 * Math.sqrt(1 + b * b))) / b;

  const n = Math.round(want / DS) + 1;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    // Invert the arc length: the angle at which the line has run k * DS.
    const t = Math.min(T, Math.log(1 + (k * DS * b) / (r0 * Math.sqrt(1 + b * b))) / b);
    const r = r0 * Math.exp(b * t);
    px[k] = r * Math.cos(t);
    py[k] = r * Math.sin(t);
  }
  const nx = new Float64Array(n);
  const ny = new Float64Array(n);
  const rmax = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1);
    const c = Math.min(n - 1, k + 1);
    const tx = px[c] - px[a];
    const ty = py[c] - py[a];
    const l = Math.hypot(tx, ty) || 1;
    nx[k] = ty / l;
    ny[k] = -tx / l;
    rmax[k] = Math.max(k ? rmax[k - 1] : 0, Math.hypot(px[k], py[k]));
  }
  return { r0, lead, px, py, nx, ny, rmax };
}

/** How big a spiral looks: the side of a square of the same area as the box round its line. */
function spiralSize(v: Variant): number {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < v.px.length; k++) {
    x0 = Math.min(x0, v.px[k]);
    x1 = Math.max(x1, v.px[k]);
    y0 = Math.min(y0, v.py[k]);
    y1 = Math.max(y1, v.py[k]);
  }
  return Math.sqrt((x1 - x0) * (y1 - y0));
}

/**
 * Spirals come in sizes between SIZE_MIN and SIZE_MAX, picked at random whatever their message: SIZE_MAX is
 * as big as the tightest shape has to be for the longest message. Each shape is built at every line length
 * (in whole segments) that comes out within that range. A looser shape packs its line less tightly, so at
 * the same size it holds fewer segments, and a long message only fits the tighter ones. A message shorter
 * than its spiral's line is written over and over along it (see encodeConversation), so every spiral looks
 * as full as any other.
 */
const SIZE_MAX = spiralSize(buildVariant(VARIANT_SHAPES[VARIANT_SHAPES.length - 1], MAX_SEGMENTS));
const SIZE_MIN = 0.85 * SIZE_MAX;
const BUILT: Array<{ v: Variant; slots: number; shape: number; size: number }> = [];
VARIANT_SHAPES.forEach((shape, k) => {
  // A shape whose lengths all step over the range still gets the one nearest it.
  let nearest: (typeof BUILT)[number] | null = null;
  const away = (size: number) => Math.max(0, SIZE_MIN - size, size - SIZE_MAX);
  let found = false;
  for (let slots = 1; slots <= 6 * MAX_SEGMENTS; slots++) {
    const v = buildVariant(shape, slots);
    const size = spiralSize(v);
    if (!nearest || away(size) < away(nearest.size)) nearest = { v, slots, shape: k, size };
    if (size > 1.02 * SIZE_MAX) break;
    if (size >= 0.98 * SIZE_MIN) {
      BUILT.push({ v, slots, shape: k, size });
      found = true;
    }
  }
  if (!found && nearest) BUILT.push(nearest);
});

/** Every shape at every length that makes it a spiral of the right size. */
export const VARIANTS = BUILT.map((b) => b.v);
/** Segments of writing along each variant's line. */
export const VARIANT_SLOTS = BUILT.map((b) => b.slots);
/** Which of VARIANT_SHAPES each variant is. */
export const VARIANT_SHAPE = BUILT.map((b) => b.shape);
const VARIANT_SIZE = BUILT.map((b) => b.size);
/** Arc length of each variant's line, eye not included. */
export const VARIANT_LEN = VARIANT_SLOTS.map((n) => sequence(n).len);

/** How far, in turns, a shape may be from the one a message's length suggests and still come up often. */
const TURN_SPREAD = 0.45;
/** Each time a shape has been used already in the conversation, its chance is multiplied by this. */
const REPEAT = 0.55;

/**
 * A spiral for a message of `need` segments: a size picked at random within the range, then a shape that
 * can hold the message, at its length nearest that size. Short messages lean to the open shapes and long
 * ones to the tight ones, but only lean: any shape that fits can come up, and the more often a shape has
 * been used already (`used`, by shape), the less likely it is, so messages of the same length still differ.
 */
export function pickVariant(rnd: () => number, need: number, used: readonly number[] = []): number {
  const target = SIZE_MIN + rnd() * (SIZE_MAX - SIZE_MIN);
  const nearest = new Map<number, number>();
  VARIANTS.forEach((_, v) => {
    if (VARIANT_SLOTS[v] < need) return;
    const best = nearest.get(VARIANT_SHAPE[v]);
    if (best === undefined || Math.abs(VARIANT_SIZE[v] - target) < Math.abs(VARIANT_SIZE[best] - target)) nearest.set(VARIANT_SHAPE[v], v);
  });
  // The turns a message of this length leans to: the loosest shape for a short one (up to two segments,
  // a greeting with its author's name already takes two), the tightest for the longest, curving between.
  const first = VARIANT_SHAPES[0].turns;
  const last = VARIANT_SHAPES[VARIANT_SHAPES.length - 1].turns;
  const t = Math.max(0, Math.min(1, (need - 2) / Math.max(1, MAX_SEGMENTS - 2)));
  const lean = first + (last - first) * t ** 0.8;
  const options = [...nearest.entries()].map(([shape, v]) => {
    const off = (VARIANT_SHAPES[shape].turns - lean) / TURN_SPREAD;
    return { v, weight: Math.exp(-(off * off) / 2) * REPEAT ** (used[shape] ?? 0) };
  });
  let pick = rnd() * options.reduce((t, o) => t + o.weight, 0);
  for (const o of options) {
    pick -= o.weight;
    if (pick <= 0) return o.v;
  }
  return options[options.length - 1].v;
}

/** Point, normal and unit tangent at arc position `s` (clamped; negative in the eye) of a spiral variant. */
export function pathAt(s: number, variant = 0) {
  const t = VARIANTS[variant];
  const f = Math.max(0, Math.min(t.px.length - 1.000001, (s + t.lead) / DS));
  const i = Math.floor(f);
  const u = f - i;
  return {
    x: t.px[i] + (t.px[i + 1] - t.px[i]) * u,
    y: t.py[i] + (t.py[i + 1] - t.py[i]) * u,
    nx: t.nx[i] + (t.nx[i + 1] - t.nx[i]) * u,
    ny: t.ny[i] + (t.ny[i + 1] - t.ny[i]) * u,
    // Normal is the tangent turned right by 90 degrees, so turn it back.
    tx: -(t.ny[i] + (t.ny[i + 1] - t.ny[i]) * u),
    ty: t.nx[i] + (t.nx[i + 1] - t.nx[i]) * u,
  };
}

/** Local coordinates (s along the arc, v across it) -> point of a spiral variant. */
export function pathMap(s: number, v: number, variant = 0): [number, number] {
  const p = pathAt(s, variant);
  return [p.x + p.nx * v, p.y + p.ny * v];
}

/** Furthest a variant's line, eye included, gets from the centre of its curl up to arc position `len`. */
const rmaxOf = (variant: number, len: number) => {
  const v = VARIANTS[variant];
  return v.rmax[Math.min(v.rmax.length - 1, Math.round((len + v.lead) / DS))];
};

/** Where a copy of a spiral sits: its variant, mirrored (about the x axis), scaled, rotated, then moved. */
export interface Placement {
  x: number;
  y: number;
  rot: number;
  mirror: 1 | -1;
  variant: number;
  /** overall size, between MIN_SCALE and MAX_SCALE */
  scale: number;
}

export function toWorld(p: Placement, x: number, y: number): [number, number] {
  const [vx, vy] = rotateVec(p, x * p.scale, y * p.scale);
  return [p.x + vx, p.y + vy];
}

function rotateVec(p: Placement, x: number, y: number): [number, number] {
  const c = Math.cos(p.rot);
  const s = Math.sin(p.rot);
  const ym = y * p.mirror;
  return [c * x - s * ym, s * x + c * ym];
}

export interface Stalk {
  p0: [number, number];
  c1: [number, number];
  c2: [number, number];
  p3: [number, number];
}

export interface LaidOut {
  placement: Placement;
  /** arc length of this spiral's line */
  len: number;
  /** joins this spiral's outer end (p0) to its parent's port (p3) */
  stalk?: Stalk;
  /** arc length along the stalk, from its p0 end, that is dressed in decoy writing */
  dressed?: number;
  /** decoy vertices near the parent left without a substituent, so they keep off the parent's writing */
  bare?: number[];
  /** seeds the decoy writing and decorations */
  seed: number;
}

/** Decoy vertex j along a stalk (unscaled): its arc position from the reply's end, and its side. */
export const decoyVertexS = (j: number) => (j + 0.5) * ZIG_A;
export const decoyVertexV = (j: number) => (j % 2 ? -ZIG_H : ZIG_H);

export interface Layout {
  nodes: LaidOut[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Deterministic random numbers in [0, 1) (mulberry32), so a conversation always looks the same. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ink points of a variant's line, eye included, up to arc position `len`. */
function inkCount(variant: number, len: number) {
  return Math.floor((len + VARIANTS[variant].lead) / INK_STEP) + 1;
}

/** Points along each variant's line (for its longest length), standing for its ink in collision checks. */
const VARIANT_INK: Array<Array<[number, number]>> = VARIANTS.map((v, i) =>
  Array.from({ length: inkCount(i, VARIANT_LEN[i]) }, (_, k) => {
    const p = pathAt(k * INK_STEP - v.lead, i);
    return [p.x, p.y];
  }),
);

const inkOf = (variant: number, len: number) => VARIANT_INK[variant].slice(0, inkCount(variant, len));

function bezierAt(b: Stalk, t: number): [number, number] {
  const u = 1 - t;
  const a = u * u * u;
  const c = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return [
    a * b.p0[0] + c * b.c1[0] + d * b.c2[0] + e * b.p3[0],
    a * b.p0[1] + c * b.c1[1] + d * b.c2[1] + e * b.p3[1],
  ];
}

/** A stalk sampled every DS of arc from its p0 end, with normals, for drawing writing along it. */
export function stalkPath(b: Stalk) {
  const fine: Array<[number, number]> = [];
  for (let i = 0; i <= 400; i++) fine.push(bezierAt(b, i / 400));
  const cum = [0];
  for (let i = 1; i < fine.length; i++) cum.push(cum[i - 1] + Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]));
  const len = cum[cum.length - 1];
  const at = (s: number) => {
    let j = 1;
    while (j < cum.length - 1 && cum[j] < s) j++;
    const f = (s - cum[j - 1]) / (cum[j] - cum[j - 1] || 1);
    const [ax, ay] = fine[j - 1];
    const [bx, by] = fine[j];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    return { x: ax + (bx - ax) * f, y: ay + (by - ay) * f, nx: (by - ay) / l, ny: -(bx - ax) / l };
  };
  return { len, map: (s: number, v: number): [number, number] => {
    const p = at(Math.max(0, Math.min(len, s)));
    return [p.x + p.nx * v, p.y + p.ny * v];
  } };
}

/** Ink points already placed, bucketed on a grid so a collision check only looks nearby. */
class InkGrid {
  private cells = new Map<string, Array<[number, number]>>();
  /** which message each point belongs to */
  private owners = new Map<[number, number], number>();

  private key(p: [number, number]) {
    return `${Math.floor(p[0] / CLEARANCE)},${Math.floor(p[1] / CLEARANCE)}`;
  }

  add(pts: Array<[number, number]>, owner: number) {
    for (const p of pts) {
      this.owners.set(p, owner);
      const cell = this.cells.get(this.key(p));
      if (cell) cell.push(p);
      else this.cells.set(this.key(p), [p]);
    }
  }

  /** Takes back points added earlier (the same arrays). */
  remove(pts: Array<[number, number]>) {
    for (const p of pts) {
      const cell = this.cells.get(this.key(p))!;
      cell.splice(cell.indexOf(p), 1);
      this.owners.delete(p);
    }
  }

  points(): Array<[number, number]> {
    return [...this.cells.values()].flat();
  }

  /** Whether (x, y) keeps CLEARANCE from all ink, but only `near` from the ink of message `owner`. */
  clearAt(x: number, y: number, owner = -1, near = CLEARANCE): boolean {
    const cx = Math.floor(x / CLEARANCE);
    const cy = Math.floor(y / CLEARANCE);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const p of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const r = this.owners.get(p) === owner ? near : CLEARANCE;
          if ((p[0] - x) ** 2 + (p[1] - y) ** 2 < r * r) return false;
        }
    return true;
  }

  /** Whether ink of message `owner` lies within `r` of (x, y). */
  ownerWithin(x: number, y: number, owner: number, r: number): boolean {
    const n = Math.ceil(r / CLEARANCE);
    const cx = Math.floor(x / CLEARANCE);
    const cy = Math.floor(y / CLEARANCE);
    for (let dy = -n; dy <= n; dy++)
      for (let dx = -n; dx <= n; dx++)
        for (const p of this.cells.get(`${cx + dx},${cy + dy}`) ?? [])
          if (this.owners.get(p) === owner && (p[0] - x) ** 2 + (p[1] - y) ** 2 < r * r) return true;
    return false;
  }

  /** Whether any placed ink lies within `r` of (x, y). */
  anyWithin(x: number, y: number, r: number): boolean {
    const n = Math.ceil(r / CLEARANCE);
    const cx = Math.floor(x / CLEARANCE);
    const cy = Math.floor(y / CLEARANCE);
    for (let dy = -n; dy <= n; dy++)
      for (let dx = -n; dx <= n; dx++)
        for (const [px, py] of this.cells.get(`${cx + dx},${cy + dy}`) ?? [])
          if ((px - x) ** 2 + (py - y) ** 2 < r * r) return true;
    return false;
  }

  /** Whether the first `len` of a spiral placed at `p` keeps clear, stopping at the first clash. */
  clearSpiral(p: Placement, len: number): boolean {
    // toWorld, inlined: this is the innermost loop of the layout search.
    const c = Math.cos(p.rot) * p.scale;
    const s = Math.sin(p.rot) * p.scale;
    const m = p.mirror;
    const ink = VARIANT_INK[p.variant];
    const n = inkCount(p.variant, len);
    for (let i = 0; i < n; i++) {
      const [x, y] = ink[i];
      if (!this.clearAt(p.x + c * x - s * y * m, p.y + s * x + c * y * m)) return false;
    }
    return true;
  }
}

/**
 * The eye of a spiral, which no other writing may enter: a disk round the centre of its curl, as a fraction
 * of how far its line reaches. The outer sweep wraps round it, and the ports lie outside it.
 */
const CORE = 0.35;

interface Core {
  x: number;
  y: number;
  r: number;
}

const coreOf = (p: Placement, len: number): Core => {
  const [x, y] = toWorld(p, 0, 0);
  return { x, y, r: Math.max(CORE * rmaxOf(p.variant, len), VARIANTS[p.variant].r0) * p.scale };
};

const inCore = (c: Core, x: number, y: number) => (x - c.x) ** 2 + (y - c.y) ** 2 < c.r * c.r;

/**
 * Places one spiral per message. `parents[i]` is the index of the message that i replies to (-1 for the
 * root) and must be smaller than i; `need[i]` is how many segments its message takes. Each spiral's size
 * and shape are picked at random among those that hold its message (see pickVariant). Each reply takes a
 * free port of its parent. `seed` (e.g. the thread id) picks the spirals' shapes, sizes, turns and branching, so
 * different conversations look different.
 *
 * A reply grows out of its parent like a branch: its stalk leaves a marker of the parent at an angle to the
 * parent's line and runs smoothly into the reply's outer end, so the two read as one stroke. Nothing may
 * touch, and no writing may reach into the middle of another spiral, so spirals stand apart rather than
 * nest. Of the placements that fit, the one heading most into open space wins, so the conversation spreads
 * out in all directions.
 *
 * A reply that finds no room makes the replies before it try their next-best spots; failing that, the
 * whole layout is redone with another (still deterministic) seed. A very crowded thread that still does not
 * fit is laid out without the rule about spirals' middles: they may then reach into each other's curls,
 * though their writing still never touches.
 */
export function layoutConversation(parents: number[], need: number[], seed = 0): Layout {
  for (const keepApart of [true, false])
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return layoutWithSeed(parents, need, seed + attempt * 7777, keepApart);
      } catch (e) {
        if (!(e instanceof NoRoom)) throw e;
      }
    }
  throw new Error('no room for reply');
}

class NoRoom extends Error {}

/** Placements tried from each free port of the parent... */
const TRIES_PER_PORT = 250;
/** ...with stalks up to (1 + this) times the shortest. */
const MAX_REACH = 16;
/** Width over height the conversation is kept to, roughly. */
const ASPECT = 4 / 3;
/** Parent's markers tried per reply. */
const PORT_TRIES = 6;
/** Best choices kept per reply to fall back on when a later reply finds no room. */
const ALTERNATIVES = 3;

interface Choice {
  node: LaidOut;
  /** ink it adds: spiral line and stalk */
  pts: Array<[number, number]>;
  core: Core;
  /** parent's port it grows from; -1 for the root */
  port: number;
  score: number;
}

/** Where a stalk leaving port `port` of a placed spiral starts, heading `fwd` along the parent's line. */
export function portAnchor(P: Placement, segments: number, port: number, fwd: number) {
  const seq = sequence(segments);
  const m = seq.markers[seq.ports[port]];
  // The hexagon of the marker away from the heading, so the stalk clears the writing next to the marker.
  const p = pathAt(m - fwd * ZIG_A, P.variant);
  const out = p.nx * p.x + p.ny * p.y > 0 ? 1 : -1;
  const [ax, ay] = toWorld(P, p.x + p.nx * out * BOND, p.y + p.ny * out * BOND);
  const [ox, oy] = rotateVec(P, p.nx * out, p.ny * out);
  const [tx, ty] = rotateVec(P, p.tx, p.ty);
  return { ax, ay, ox, oy, tx, ty };
}

function layoutWithSeed(parents: number[], need: number[], seed: number, keepApart: boolean): Layout {
  const replies = new Map<number, number>();
  parents.forEach((parent, i) => {
    if (parent >= i) throw new Error('reply must come after its parent');
    if (parent >= 0) replies.set(parent, (replies.get(parent) ?? 0) + 1);
  });
  if ([...replies.values()].some((n) => n > PORTS)) throw new Error(`a message can take at most ${PORTS} replies`);

  const nodes: LaidOut[] = [];
  const ink = new InkGrid();
  const cores: Core[] = [];
  /** extent of each placed spiral's ink, and its middle */
  const boxes: Array<{ minX: number; maxX: number; minY: number; maxY: number; cx: number; cy: number }> = [];
  const boxOf = (pts: Array<[number, number]>) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { minX, maxX, minY, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  };
  const taken = parents.map(() => new Set<number>());
  const spiralInk = (p: Placement, len: number) => inkOf(p.variant, len).map(([x, y]) => toWorld(p, x, y));
  const avoidsCores = (pts: Array<[number, number]>) => !keepApart || pts.every(([x, y]) => !cores.some((c) => inCore(c, x, y)));

  /** Where message i could go, given everything placed before it, best first. */
  const choicesFor = (i: number): Choice[] => {
    const parent = parents[i];
    const rnd = random(seed * 7919 + i * 104729 + 1);
    const scale = MIN_SCALE + rnd() * (MAX_SCALE - MIN_SCALE);
    const nodeSeed = Math.floor(rnd() * 2 ** 31);
    if (parent < 0) {
      // The first message sits in the middle of the conversation, which spreads out to either side of it;
      // its open outer end points down (screen y runs down), give or take.
      const mirror = rnd() < 0.5 ? 1 : -1;
      const variant = pickVariant(rnd, need[i]);
      const len = VARIANT_LEN[variant];
      const tail = pathAt(len, variant);
      const rot = Math.PI / 2 + (rnd() - 0.5) * 0.8 - Math.atan2(mirror * tail.y, tail.x);
      const placement: Placement = { x: 0, y: 0, rot, mirror, variant, scale };
      return [{ node: { placement, len, seed: nodeSeed }, pts: spiralInk(placement, len), core: coreOf(placement, len), port: -1, score: 0 }];
    }

    const P = nodes[parent].placement;
    const parentSegments = VARIANT_SLOTS[P.variant];
    // Shapes used so far, so the reply's leans to the others.
    const shapesUsed = VARIANT_SHAPES.map((_, k) => nodes.filter((n) => VARIANT_SHAPE[n.placement.variant] === k).length);
    const parentSeq = sequence(parentSegments);
    const branch = BRANCH + (rnd() - 0.5) * 0.4;
    const RB = Math.max(...VARIANTS.map((_, k) => rmaxOf(k, VARIANT_LEN[k])));
    const choices: Choice[] = [];

    const fromPort = (port: number) => {
      // A fixed number of random tries, whether or not any fit, so a crowded spot costs no more than an open
      // one. Short stalks near the natural branch direction come up most often; further out, the stalk may
      // swing further round to find room.
      for (let tryNo = 0; tryNo < (keepApart ? 1 : 2) * TRIES_PER_PORT; tryNo++) {
        const reach = rnd() ** 2;
        const gap = STALK * (1 + MAX_REACH * reach);
        const swing = (2 * rnd() - 1) * (0.5 + 1.6 * reach);
        const fwd = rnd() < 0.5 ? 1 : -1;
        const { ax, ay, ox, oy, tx, ty } = portAnchor(P, parentSegments, port, fwd);
        // Outwards from the parent, so replies do not curl up inside it; only a crowded thread may also
        // branch into the parent's own curl.
        const side = keepApart || rnd() < 0.6 ? 1 : -1;
        const sx = ox * side;
        const sy = oy * side;
        const mirror = rnd() < 0.5 ? 1 : -1;
        const variant = pickVariant(rnd, need[i], shapesUsed);
        const len = VARIANT_LEN[variant];
        const bx = fwd * tx * Math.cos(branch) + sx * Math.sin(branch);
        const by = fwd * ty * Math.cos(branch) + sy * Math.sin(branch);
        const dx = bx * Math.cos(swing) - by * Math.sin(swing);
        const dy = bx * Math.sin(swing) + by * Math.cos(swing);
        const qx = ax + dx * gap;
        const qy = ay + dy * gap;
        // Turn the copy so its line, followed outwards, ends heading straight back along the stalk.
        const tail = pathAt(len, variant);
        const rot = Math.atan2(-dy, -dx) - Math.atan2(mirror * tail.ty, tail.tx);
        const [ex, ey] = rotateVec({ x: 0, y: 0, rot, mirror, variant, scale }, tail.x * scale, tail.y * scale);
        const placement: Placement = { x: qx - ex, y: qy - ey, rot, mirror, variant, scale };
        // Cheapest checks first: eyes apart, then the spiral's own line, where most candidates fail.
        const core = coreOf(placement, len);
        if (keepApart && cores.some((c) => Math.hypot(c.x - core.x, c.y - core.y) < c.r + core.r)) continue;
        if (!ink.clearSpiral(placement, len)) continue;
        const pts = spiralInk(placement, len);
        if (!avoidsCores(pts) || (keepApart && ink.anyWithin(core.x, core.y, core.r))) continue;
        // Capped, so a long stalk turns towards its spiral early instead of running far along the branch.
        const k1 = Math.min(0.4 * gap, 4 * CLEARANCE);
        const stalk: Stalk = { p0: [qx, qy], c1: [qx - dx * k1, qy - dy * k1], c2: [ax + bx * k1, ay + by * k1], p3: [ax, ay] };
        const n = Math.max(2, Math.ceil(gap / INK_STEP));
        const line: Array<[number, number]> = [];
        for (let s = 0; s <= n; s++) line.push(bezierAt(stalk, s / n));
        // It may never hook round to reach the port from the parent's other side.
        if (!line.every(([x, y]) => (x - ax) * sx + (y - ay) * sy > -STROKE)) continue;
        // The stalk carries writing from the reply's end right down to its parent, as one band branching off
        // another. Only where it crosses the parent's own band is it bare: a branch's writing must not cover
        // what the parent says. Everywhere else it keeps the usual distance from all writing.
        const near = NECK * P.scale;
        let neck = n;
        while (neck > 0 && !ink.clearAt(...line[neck], parent, near)) neck--;
        // A crowded thread may leave a longer bare neck.
        if (Math.hypot(line[neck][0] - ax, line[neck][1] - ay) > (keepApart ? 3 : 8) * near) continue;
        const dressedLine = line.slice(0, neck + 1);
        if (!dressedLine.every(([x, y]) => ink.clearAt(x, y, parent, near)) || !avoidsCores(dressedLine)) continue;
        let dressed = 0;
        for (let s = 1; s <= neck; s++) dressed += Math.hypot(line[s][0] - line[s - 1][0], line[s][1] - line[s - 1][1]);
        // Near the parent, a decoy substituent pointing its way would reach into the parent's band: those
        // vertices stay bare. (Vertices are counted from the reply's end, as decoyStrokes draws them.)
        const { map } = stalkPath(stalk);
        const bare: number[] = [];
        for (let j = 0; decoyVertexS(j) * scale <= dressed; j++) {
          const tip = map(decoyVertexS(j) * scale, Math.sign(decoyVertexV(j)) * BAND * scale);
          if (ink.ownerWithin(tip[0], tip[1], parent, near)) bare.push(j);
        }
        // The conversation is kept together in a box of about ASPECT, as small as it will go, with the first
        // message in the middle across it: each reply goes where it grows that box least, turning back towards
        // the other side or down into an empty corner when that is where the room is. Measured on the spirals'
        // bodies (their ink), not their eyes. Short stalks are preferred; a little noise keeps it organic.
        const box = boxOf(pts);
        const minX = Math.min(box.minX, ...boxes.map((b) => b.minX));
        const maxX = Math.max(box.maxX, ...boxes.map((b) => b.maxX));
        const minY = Math.min(box.minY, ...boxes.map((b) => b.minY));
        const maxY = Math.max(box.maxY, ...boxes.map((b) => b.maxY));
        const size = Math.sqrt((maxX - minX) * (maxY - minY)) / RB;
        const shape = Math.abs(Math.log((maxX - minX) / (maxY - minY) / ASPECT));
        const lopsided = Math.abs((minX + maxX) / 2 - boxes[0].cx) / RB;
        choices.push({
          node: { placement, len, stalk, dressed, bare, seed: nodeSeed },
          pts: [...pts, ...line],
          core,
          port,
          score: -1.0 * size - 3 * shape - 0.8 * lopsided - (gap / RB) * 0.4 + 0.3 * rnd(),
        });
      }
    };

    // Any free marker will do, the reading does not depend on which one a reply grew from: a few, picked at
    // random, are tried. Markers at or next to one already taken are left alone while others remain, so
    // branches keep apart.
    const markerOf = (k: number) => parentSeq.ports[k];
    const used = [...taken[parent]].map(markerOf);
    const open = parentSeq.ports.map((_, k) => k).filter((k) => !taken[parent].has(k));
    const apart = open.filter((k) => used.every((m) => Math.abs(m - markerOf(k)) > 1));
    const free = apart.length ? apart : open;
    for (let n = 0; n < (keepApart ? PORT_TRIES : Infinity) && free.length; n++) fromPort(free.splice(Math.floor(rnd() * free.length), 1)[0]);
    return choices.sort((a, b) => b.score - a.score).slice(0, ALTERNATIVES);
  };

  // Depth-first: when a reply finds no room, the replies before it try their next-best spots. A budget
  // stops this from running away; then the caller starts over with another seed.
  let budget = 4 * parents.length;
  const place = (i: number): boolean => {
    if (i === parents.length) return true;
    if (budget-- <= 0) throw new NoRoom('layout search exhausted');
    const cs = choicesFor(i);
    for (const c of cs) {
      nodes.push(c.node);
      if (c.port >= 0) taken[parents[i]].add(c.port);
      ink.add(c.pts, i);
      cores.push(c.core);
      boxes.push(boxOf(c.pts));
      if (place(i + 1)) return true;
      nodes.pop();
      if (c.port >= 0) taken[parents[i]].delete(c.port);
      ink.remove(c.pts);
      cores.pop();
      boxes.pop();
    }
    return false;
  };
  if (!place(0)) throw new NoRoom('no room for reply');

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ink.points()) {
    minX = Math.min(minX, x - INK_R);
    minY = Math.min(minY, y - INK_R);
    maxX = Math.max(maxX, x + INK_R);
    maxY = Math.max(maxY, y + INK_R);
  }
  return { nodes, minX, minY, maxX, maxY };
}
