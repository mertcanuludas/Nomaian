// The scanning animation drawn over the camera picture: five beams of light that start as a point off the
// bottom right corner, fan out and land on the writing, where each ends in a bright line across it. The
// lines run along the writing from one end to the other and back, each at its own pace. Spirals whose
// message is known get its number beside them. With no writing in sight, the beams fade away.

import type { ChainSeen, Pt } from './core/decode';

/** One beam: where it is along the writing (0..1), which way it is going, and how fast (share per second). */
interface Beam {
  at: number;
  dir: number;
  speed: number;
  /** the chain it runs along, among those seen */
  chain: number;
  /** where its bright line is drawn, eased towards where it should be so it glides between frames */
  x: number;
  y: number;
  nx: number;
  ny: number;
  placed: boolean;
  /** where the beam should be (before easing), so a new frame picks up from there */
  tx: number;
  ty: number;
}

const BEAMS = 5;
/** Shares of a chain's length a beam covers per second: all different, so they drift apart. */
const SPEEDS = [0.11, 0.16, 0.22, 0.29, 0.37];

/** A chain as a polyline, with its length so far at each point. */
interface Path {
  pts: Pt[];
  cum: number[];
  /** how long the bright line across it is: about the width of the band of writing */
  reach: number;
}

function pathOf(chain: ChainSeen): Path | null {
  const pts = chain.path.length >= 2 ? chain.path : chain.markers;
  if (pts.length < 2 || chain.markers.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  if (!total) return null;
  // Markers are a gap apart and the band of writing is about a third of a gap wide: the line reaches well
  // past it on either side.
  return { pts, cum, reach: 0.8 * (total / (chain.markers.length - 1)) };
}

/** Point and unit normal at share \`t\` of a path's length. */
function pointAt(p: Path, t: number) {
  const target = Math.max(0, Math.min(1, t)) * p.cum[p.cum.length - 1];
  let i = 1;
  while (i < p.cum.length - 1 && p.cum[i] < target) i++;
  const a = p.pts[i - 1];
  const b = p.pts[i];
  const seg = p.cum[i] - p.cum[i - 1] || 1;
  const f = (target - p.cum[i - 1]) / seg;
  const tx = (b.x - a.x) / seg;
  const ty = (b.y - a.y) / seg;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, nx: -ty, ny: tx };
}

/** How long the beams stay on writing that frames have stopped finding, before they fade. */
const HOLD_MS = 1500;

/** The chain and share of its length nearest a point, and how far it is. */
function nearestOn(paths: Path[], x: number, y: number) {
  let best: { chain: number; t: number; d: number } | null = null;
  paths.forEach((p, chain) => {
    const total = p.cum[p.cum.length - 1];
    for (let i = 1; i < p.pts.length; i++) {
      const a = p.pts[i - 1];
      const b = p.pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - a.x - f * dx, y - a.y - f * dy);
      if (!best || d < best.d) best = { chain, t: (p.cum[i - 1] + f * (p.cum[i] - p.cum[i - 1])) / total, d };
    }
  });
  return best as { chain: number; t: number; d: number } | null;
}

export class ScanBeams {
  private beams: Beam[] = Array.from({ length: BEAMS }, (_, i) => ({
    at: (i + 0.5) / BEAMS,
    dir: i % 2 ? -1 : 1,
    speed: SPEEDS[i],
    chain: 0,
    x: 0,
    y: 0,
    nx: 0,
    ny: 1,
    placed: false,
    tx: 0,
    ty: 0,
  }));
  private paths: Path[] = [];
  private labels: Array<{ x: number; y: number; n: number }> = [];
  /** how visible the beams are, easing towards 1 while there is writing and 0 when there is none */
  private shown = 0;
  private last = 0;

  /** When the chains were last seen, to ride out a frame or two that finds none. */
  private seenAt = 0;

  /** The chains found in the latest frame, in that frame's pixels. */
  setChains(chains: ChainSeen[], now = performance.now()) {
    const kept = chains.map((c) => ({ c, path: pathOf(c) })).filter((x) => x.path) as Array<{ c: ChainSeen; path: Path }>;
    // Frames take turns at how they pick out the ink, so one may find nothing where the last found writing:
    // the beams stay where they were for a moment before fading.
    if (!kept.length) {
      if (now - this.seenAt > HOLD_MS) {
        this.paths = [];
        this.labels = [];
      }
      return;
    }
    this.seenAt = now;
    // The longest chains first, so the beams go where most of the writing is.
    kept.sort((a, b) => b.path.cum[b.path.cum.length - 1] - a.path.cum[a.path.cum.length - 1]);
    this.paths = kept.slice(0, BEAMS).map((x) => x.path);
    // Each frame finds the chains a little differently: each beam carries on from the nearest point of the
    // nearest chain, rather than jumping to another chain and sweeping across empty space to get there.
    // Beams not near any go where the fewest are.
    const load = this.paths.map(() => 0);
    const unplaced: Beam[] = [];
    for (const b of this.beams) {
      const near = b.placed ? nearestOn(this.paths, b.tx, b.ty) : null;
      if (near && near.d < 1.5 * this.paths[near.chain].reach) {
        b.chain = near.chain;
        b.at = near.t;
        load[near.chain]++;
      } else unplaced.push(b);
    }
    for (const b of unplaced) {
      b.chain = load.indexOf(Math.min(...load));
      load[b.chain]++;
      b.placed = false;
    }
    // One number per message, beside its longest chain, off to the side of the middle of it.
    const seen = new Set<number>();
    this.labels = [];
    for (const { c, path } of kept) {
      if (c.message < 0 || seen.has(c.message)) continue;
      seen.add(c.message);
      const mid = pointAt(path, 0.5);
      const cx = c.markers.reduce((s, p) => s + p.x, 0) / c.markers.length;
      const cy = c.markers.reduce((s, p) => s + p.y, 0) / c.markers.length;
      // Towards the inside of the curve, where there is room, just clear of the writing.
      const dx = cx - mid.x;
      const dy = cy - mid.y;
      const d = Math.hypot(dx, dy) || 1;
      const off = Math.min(d, 0.6 * path.reach);
      this.labels.push({ x: mid.x + (dx / d) * off, y: mid.y + (dy / d) * off, n: c.message + 1 });
    }
  }

  clear() {
    this.paths = [];
    this.labels = [];
    this.shown = 0;
    this.beams.forEach((b) => (b.placed = false));
  }

  /** Draws one moment of the animation on a canvas the size of the frame. */
  draw(ctx: CanvasRenderingContext2D, now: number) {
    const { width: w, height: h } = ctx.canvas;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    this.shown += ((this.paths.length ? 1 : 0) - this.shown) * Math.min(1, dt * 4);
    ctx.clearRect(0, 0, w, h);
    if (this.shown < 0.01) return;

    const unit = Math.max(w, h) / 1000;
    // The beams start as a point just off the bottom right corner.
    const ox = w * 1.02;
    const oy = h * 0.9;
    const ease = Math.min(1, dt * 10);
    for (const b of this.beams) {
      const path = this.paths[b.chain];
      if (path) {
        b.at += b.dir * b.speed * dt;
        if (b.at > 1) (b.at = 2 - b.at), (b.dir = -1);
        if (b.at < 0) (b.at = -b.at), (b.dir = 1);
        const p = pointAt(path, b.at);
        b.tx = p.x;
        b.ty = p.y;
        const half = path.reach / 2;
        if (!b.placed) Object.assign(b, { x: p.x, y: p.y, nx: p.nx * half, ny: p.ny * half, placed: true });
        b.x += (p.x - b.x) * ease;
        b.y += (p.y - b.y) * ease;
        b.nx += (p.nx * half - b.nx) * ease;
        b.ny += (p.ny * half - b.ny) * ease;
      }
      if (!b.placed) continue;
      const ax = b.x - b.nx;
      const ay = b.y - b.ny;
      const bx = b.x + b.nx;
      const by = b.y + b.ny;

      // The beam: a pale wedge from the point to the line, brighter towards the writing.
      const fade = ctx.createLinearGradient(ox, oy, b.x, b.y);
      fade.addColorStop(0, 'rgba(140, 170, 255, 0)');
      fade.addColorStop(1, `rgba(140, 170, 255, ${0.38 * this.shown})`);
      ctx.fillStyle = fade;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.closePath();
      ctx.fill();

      // The bright line across the writing: a soft glow, then a light core.
      ctx.lineCap = 'round';
      for (const [colour, width, blur] of [
        [`rgba(90, 200, 255, ${0.45 * this.shown})`, 9 * unit, 14 * unit],
        [`rgba(200, 245, 255, ${0.95 * this.shown})`, 3 * unit, 0],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        ctx.shadowColor = 'rgba(90, 200, 255, 0.9)';
        ctx.shadowBlur = blur;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    // Message numbers beside their spirals.
    const r = 15 * unit;
    ctx.font = `600 ${Math.round(16 * unit)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of this.labels) {
      ctx.globalAlpha = this.shown;
      ctx.fillStyle = 'rgba(8, 20, 34, 0.75)';
      ctx.strokeStyle = 'rgba(120, 220, 255, 0.95)';
      ctx.lineWidth = 2 * unit;
      ctx.shadowColor = 'rgba(90, 200, 255, 0.9)';
      ctx.shadowBlur = 10 * unit;
      ctx.beginPath();
      ctx.arc(l.x, l.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#dff6ff';
      ctx.fillText(String(l.n), l.x, l.y + unit);
      ctx.globalAlpha = 1;
    }
  }
}
