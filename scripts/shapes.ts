// Draws each spiral shape for a mid-length message side by side: npx vite-node scripts/shapes.ts
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'fs';
import { pathAt, SHAPES, VARIANT_LEN, VARIANT_SHAPE, VARIANT_SLOTS } from '../src/core/layout';

mkdirSync('tests/out', { recursive: true });
const cell = 520;
const c = createCanvas(cell * SHAPES, cell);
const ctx = c.getContext('2d');
ctx.fillStyle = '#1c1416';
ctx.fillRect(0, 0, c.width, c.height);
ctx.strokeStyle = '#f4f8ff';
ctx.lineWidth = 6;
ctx.lineCap = 'round';
for (let k = 0; k < SHAPES; k++) {
  // Each shape at its longest line.
  const v = VARIANT_SHAPE.reduce((b, sh, i) => (sh === k && (b < 0 || VARIANT_SLOTS[i] > VARIANT_SLOTS[b]) ? i : b), -1);
  const len = VARIANT_LEN[v];
  const pts: Array<[number, number]> = [];
  for (let s = -2000; s <= len; s += 4) {
    const p = pathAt(s, v);
    pts.push([p.x, p.y]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const sc = (cell - 80) / span;
  const ox = k * cell + cell / 2 - ((Math.max(...xs) + Math.min(...xs)) / 2) * sc;
  const oy = cell / 2 - ((Math.max(...ys) + Math.min(...ys)) / 2) * sc;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * sc, oy + y * sc) : ctx.moveTo(ox + x * sc, oy + y * sc)));
  ctx.stroke();
}
writeFileSync('tests/out/shapes.png', c.toBuffer('image/png'));
console.log('tests/out/shapes.png');
