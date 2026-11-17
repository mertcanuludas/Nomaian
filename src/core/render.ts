import type { EncodedConversation } from './encode';
import { pathMap, random, sequence, stalkPath, STROKE, VARIANTS } from './layout';
import { decoyStrokes, spiralStrokes } from './shapes';

export interface Theme {
  id: string;
  name: string;
  background: string;
  ink: string;
  /** optional translucent halo drawn under the ink */
  glow?: string;
  /** optional brick wall behind the writing: groove colours, strongest at the edges, gone in the middle */
  bricks?: { light: string; dark: string };
}

/**
 * Backgrounds: walls, with the surface colour and the light and dark edges of the grooves between their
 * bricks; a plain white page; and none at all ('transparent'), for putting the writing on something else.
 */
export const WALLS: Array<{ id: string; name: string; background: string; bricks?: Theme['bricks'] }> = [
  { id: 'bordo', name: 'Bordo duvar', background: '#1c1416', bricks: { light: '#4a3238', dark: '#0c0809' } },
  { id: 'mor', name: 'Mor duvar', background: '#5b4577', bricks: { light: '#9a82bd', dark: '#36284a' } },
  { id: 'sari', name: 'Sarı duvar', background: '#b8954e', bricks: { light: '#e9d08f', dark: '#7a5d28' } },
  { id: 'beyaz', name: 'Düz beyaz', background: '#ffffff' },
  { id: 'bos', name: 'Boş (saydam)', background: 'transparent' },
];

/**
 * Colours of the writing, with its glow, and the colour that stands for it on a button. `allOnly` colours
 * are offered only for the whole conversation at once, not message by message.
 */
export const INKS: Array<{ id: string; name: string; ink: string; glow?: string; swatch: string; allOnly?: boolean }> = [
  { id: 'mavi', name: 'Mavi yazı', ink: '#f4f8ff', glow: 'rgba(110,215,255,0.22)', swatch: '#7fd3ff' },
  { id: 'beyaz', name: 'Beyaz yazı', ink: '#fdfbff', glow: 'rgba(235,225,255,0.38)', swatch: '#ffffff' },
  { id: 'turuncu', name: 'Turuncu yazı', ink: '#ffb59a', glow: 'rgba(255,110,70,0.32)', swatch: '#ff9468' },
  { id: 'siyah', name: 'Siyah yazı', ink: '#14100f', swatch: '#14100f', allOnly: true },
];

/** A wall with writing of a given colour. */
export function wallTheme(wall: string, ink: string): Theme {
  const w = WALLS.find((x) => x.id === wall) ?? WALLS[0];
  const k = INKS.find((x) => x.id === ink) ?? INKS[0];
  return { id: `${w.id}-${k.id}`, name: `${w.name}, ${k.name}`, background: w.background, bricks: w.bricks, ink: k.ink, glow: k.glow };
}

export const THEMES: Theme[] = [
  { ...wallTheme('bordo', 'mavi'), id: 'nomai', name: 'Nomai' },
];

/** Minimal 2D context surface we rely on; satisfied by browser and @napi-rs/canvas. */
type Ctx = Pick<
  CanvasRenderingContext2D,
  'save' | 'restore' | 'fillRect' | 'beginPath' | 'stroke' | 'moveTo' | 'lineTo' | 'translate' | 'scale' | 'closePath' | 'fill'
> & {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
};

/** Side of one square of the brick grid, in glyph units. */
const CELL = 92;

/** The bolt: two corners joined end to end, six squares. */
const BOLT: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2], [2, 3]];
/** Brick shapes, as squares (column, row), in every orientation: the bolt, a pair, a single square. */
const BOLTS = (() => {
  const out: Array<Array<[number, number]>> = [];
  const seen = new Set<string>();
  for (const flip of [1, -1])
    for (let turn = 0; turn < 4; turn++) {
      let cells = BOLT.map(([c, r]): [number, number] => [c * flip, r]);
      for (let t = 0; t < turn; t++) cells = cells.map(([c, r]): [number, number] => [-r, c]);
      // Shift so the first square in reading order (row, then column) is at (0, 0).
      cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const [c0, r0] = cells[0];
      cells = cells.map(([c, r]): [number, number] => [c - c0, r - r0]);
      const key = JSON.stringify(cells);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(cells);
      }
    }
  return out;
})();
const PAIRS: Array<Array<[number, number]>> = [[[0, 0], [1, 0]], [[0, 0], [0, 1]]];

/**
 * Draws a wall laid at 45 degrees over a w x h area, of bricks shaped like a bolt (six squares), a pair of
 * squares or a single one, fitted together at random. The wall is not quite even: some bricks stand out a
 * little (about one in thirty), lit on their upper left edges and shadowed on the lower right, a few are sunk in, the other way
 * round, and the rest are flush, with plain grooves. Bricks are plain at the edges of the drawing and fade
 * out towards its middle, so the writing stands on a clear surface.
 */
function drawBricks(ctx: Ctx, w: number, h: number, bricks: NonNullable<Theme['bricks']>, seed: number) {
  const rnd = random(seed);
  const c = Math.SQRT1_2;
  // Grid coordinates (u, v) are the drawing's turned by 45 degrees, centred on it.
  const toXY = (u: number, v: number): [number, number] => [w / 2 + c * (u - v) * CELL, h / 2 + c * (u + v) * CELL];
  // How strongly a point shows: 0 in the middle of the drawing, 1 at its edges (a rounded rectangle).
  const strength = (x: number, y: number) => {
    const nx = Math.abs(x / w - 0.5) * 2;
    const ny = Math.abs(y / h - 0.5) * 2;
    const d = Math.pow(nx ** 4 + ny ** 4, 0.25);
    const t = Math.max(0, Math.min(1, (d - 0.45) / 0.5));
    return t * t * (3 - 2 * t);
  };

  // Fill the grid square by square in reading order: at each empty square try a bolt, then a pair, then
  // a single square, which always fits.
  const n = Math.ceil((w + h) / CELL / Math.SQRT2) + 3;
  const owner = new Map<string, number>();
  const key = (u: number, v: number) => `${u},${v}`;
  const pieces: Array<Array<[number, number]>> = [];
  const fits = (u: number, v: number, cells: Array<[number, number]>) =>
    cells.every(([du, dv]) => Math.abs(u + du) <= n && Math.abs(v + dv) <= n && !owner.has(key(u + du, v + dv)));
  for (let v = -n; v <= n; v++)
    for (let u = -n; u <= n; u++) {
      if (owner.has(key(u, v))) continue;
      const roll = rnd();
      let shape: Array<[number, number]> = [[0, 0]];
      const tryShapes = (set: Array<Array<[number, number]>>) => {
        const start = Math.floor(rnd() * set.length);
        for (let i = 0; i < set.length; i++) {
          const s = set[(start + i) % set.length];
          if (fits(u, v, s)) return s;
        }
        return null;
      };
      if (roll < 0.55) shape = tryShapes(BOLTS) ?? tryShapes(PAIRS) ?? shape;
      else if (roll < 0.85) shape = tryShapes(PAIRS) ?? shape;
      const cells = shape.map(([du, dv]): [number, number] => [u + du, v + dv]);
      for (const [cu, cv] of cells) owner.set(key(cu, cv), pieces.length);
      pieces.push(cells);
    }

  // Light falls from the upper left of the drawing.
  const lightX = -c;
  const lightY = -c;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  pieces.forEach((cells, id) => {
    const [cx, cy] = toXY(
      cells.reduce((s, p) => s + p[0] + 0.5, 0) / cells.length,
      cells.reduce((s, p) => s + p[1] + 0.5, 0) / cells.length,
    );
    if (cx < -3 * CELL || cy < -3 * CELL || cx > w + 3 * CELL || cy > h + 3 * CELL) return;
    const a = strength(cx, cy);
    const relief = rnd();
    if (a < 0.02) return;
    // +1 stands out, -1 is sunk in, 0 is flush.
    const depth = relief < 0.03 ? 1 : relief < 0.055 ? -1 : 0;
    // A raised brick catches a little more light on its face, a sunk one a little less.
    if (depth) {
      ctx.globalAlpha = 0.22 * a;
      ctx.fillStyle = depth > 0 ? bricks.light : bricks.dark;
      ctx.beginPath();
      for (const [u, v] of cells) {
        const q = [toXY(u, v), toXY(u + 1, v), toXY(u + 1, v + 1), toXY(u, v + 1)];
        q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
      }
      ctx.fill();
    }
    // The brick's outline, edge by edge: where a neighbouring square belongs to another brick.
    const sides: Array<[number, number, number, number, number, number]> = [
      [0, 0, 1, 0, 0, -1],
      [1, 0, 1, 1, 1, 0],
      [1, 1, 0, 1, 0, 1],
      [0, 1, 0, 0, -1, 0],
    ];
    for (const [u, v] of cells)
      for (const [au, av, bu, bv, nu, nv] of sides) {
        if (owner.get(key(u + nu, v + nv)) === id) continue;
        const [x0, y0] = toXY(u + au, v + av);
        const [x1, y1] = toXY(u + bu, v + bv);
        // Outward normal on the drawing, and whether it faces the light.
        const nx = c * (nu - nv);
        const ny = c * (nu + nv);
        const lit = nx * lightX + ny * lightY > 0;
        // The groove itself, then the brick's own edge just inside it: lit or shaded by its relief.
        ctx.globalAlpha = 0.8 * a;
        ctx.strokeStyle = bricks.dark;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        const edge = depth === 0 ? (lit ? null : bricks.light) : (lit === depth > 0 ? bricks.light : bricks.dark);
        if (!edge) continue;
        const inset = depth === 0 ? -1.4 : -1.6;
        ctx.globalAlpha = (depth ? 0.9 : 0.6) * a;
        ctx.strokeStyle = edge;
        ctx.lineWidth = depth ? 2.2 : 1.2;
        ctx.beginPath();
        ctx.moveTo(x0 + nx * inset, y0 + ny * inset);
        ctx.lineTo(x1 + nx * inset, y1 + ny * inset);
        ctx.stroke();
      }
  });
  ctx.restore();
}

/** Quiet margin around the ink, in glyph units. */
export const MARGIN = 60;
/** Default export resolution, in pixels per glyph unit. */
export const PX_PER_UNIT = 1.6;

/** Size of the drawing in glyph units, margin included. */
function extent(enc: EncodedConversation) {
  const { minX, minY, maxX, maxY } = enc.layout;
  return { w: maxX - minX + 2 * MARGIN, h: maxY - minY + 2 * MARGIN };
}

/** Pixel size and glyph-units -> pixels scale for an image of the conversation. */
export function imageSize(enc: EncodedConversation, maxSide = 6000) {
  const { w, h } = extent(enc);
  const scale = Math.min(PX_PER_UNIT, maxSide / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale), scale };
}

/** Every stroke of the conversation, in drawing coordinates. */
export function conversationStrokes(enc: EncodedConversation): Array<Array<[number, number]>> {
  return messageStrokes(enc).flat();
}

/** The strokes of each message's spiral (and of the stalk joining it to its parent), by message. */
function messageStrokes(enc: EncodedConversation): Array<Array<Array<[number, number]>>> {
  return enc.layout.nodes.map((node, i) => {
    const out: Array<Array<[number, number]>> = [];
    const p = node.placement;
    const rnd = random(node.seed);
    const c = Math.cos(p.rot) * p.scale;
    const s = Math.sin(p.rot) * p.scale;
    const toWorld = ([sa, v]: [number, number]): [number, number] => {
      const [x, y] = pathMap(sa, v, p.variant);
      const ym = y * p.mirror;
      return [p.x + c * x - s * ym, p.y + s * x + c * ym];
    };
    for (const st of spiralStrokes(sequence(enc.segments[i]), enc.values[i], rnd, VARIANTS[p.variant].lead)) out.push(st.map(toWorld));
    if (node.stalk) {
      const { len, map } = stalkPath(node.stalk);
      // The stalk is all writing, its chain running right into the parent's marker: no plain line anywhere.
      // Decoy writing scales with the stalk's own spiral, so it matches its neighbour.
      for (const st of decoyStrokes(len / p.scale, rnd, node.bare, (node.dressed ?? 0) / p.scale))
        out.push(st.map(([sa, v]) => map(sa * p.scale, v * p.scale)));
    }
    return out;
  });
}

/** Draws the conversation at the context origin, at `scale` pixels per glyph unit (see imageSize). */
export function renderConversation(ctx: Ctx, enc: EncodedConversation, scale: number, theme: Theme = THEMES[0]): void {
  const { w, h } = extent(enc);
  const { minX, minY } = enc.layout;
  ctx.save();
  // A transparent background is left unpainted.
  if (theme.background !== 'transparent') {
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, w * scale, h * scale);
  }
  ctx.scale(scale, scale);
  if (theme.bricks) drawBricks(ctx, w, h, theme.bricks, enc.conversation.thread + 1);
  ctx.translate(MARGIN - minX, MARGIN - minY);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Each message is drawn in its own ink colour if it has one, else in the theme's. Messages of the same
  // colour are drawn together.
  const byInk = new Map<string, { ink: string; glow?: string; strokes: Array<Array<[number, number]>> }>();
  messageStrokes(enc).forEach((strokes, i) => {
    const own = INKS.find((k) => k.id === enc.conversation.messages[i]?.ink);
    const ink = own ? { ink: own.ink, glow: own.glow } : { ink: theme.ink, glow: theme.glow };
    const key = `${ink.ink}|${ink.glow ?? ''}`;
    const group = byInk.get(key);
    if (group) group.strokes.push(...strokes);
    else byInk.set(key, { ...ink, strokes: [...strokes] });
  });
  const trace = (strokes: Array<Array<[number, number]>>) => {
    ctx.beginPath();
    for (const st of strokes) st.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  };
  // Glow is a wider, translucent underlay rather than canvas shadows, which render inconsistently across
  // engines. Each pass is one path per colour, so overlapping strokes do not stack their transparency. All
  // the glow goes down first, so no message's glow covers another's writing.
  for (const grow of [2.4 * STROKE, 1.0 * STROKE])
    for (const g of byInk.values()) {
      if (!g.glow) continue;
      ctx.strokeStyle = g.glow;
      ctx.lineWidth = STROKE + grow;
      trace(g.strokes);
    }
  for (const g of byInk.values()) {
    ctx.strokeStyle = g.ink;
    ctx.lineWidth = STROKE;
    trace(g.strokes);
  }
  ctx.restore();
}
