// Crops part of a preview for close inspection: npx vite-node scripts/crop.ts in.png out.png x y w h [zoom]
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync } from 'fs';
const [inp, out, x, y, w, h, z] = process.argv.slice(2);
const img = await loadImage(inp);
const zoom = Number(z ?? 1);
const c = createCanvas(Number(w) * zoom, Number(h) * zoom);
c.getContext('2d').drawImage(img, Number(x), Number(y), Number(w), Number(h), 0, 0, c.width, c.height);
writeFileSync(out, c.toBuffer('image/png'));
