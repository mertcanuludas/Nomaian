// Photo simulation shared by the tests and the diagnostic scripts.
import { apply, homography } from '../src/core/homography';

type Canvas = { width: number; height: number; getContext(t: '2d'): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } };

/** Simulates a photo: perspective warp onto a larger background, blur, noise. */
export function photo(
  src: Canvas,
  opts: { w: number; h: number; corners: [number, number][]; blur?: number; noise?: number; bg?: number },
) {
  const sw = src.width;
  const sh = src.height;
  const srcData = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const H = homography(
    opts.corners.map(([x, y]) => ({ x, y })),
    [{ x: 0, y: 0 }, { x: sw, y: 0 }, { x: sw, y: sh }, { x: 0, y: sh }],
  );
  const out = new Uint8ClampedArray(opts.w * opts.h * 4);
  const bg = opts.bg ?? 200;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let y = 0; y < opts.h; y++)
    for (let x = 0; x < opts.w; x++) {
      const p = apply(H, x + 0.5, y + 0.5);
      const i = (y * opts.w + x) * 4;
      const sx = Math.floor(p.x);
      const sy = Math.floor(p.y);
      // Lighting gradient across the photo.
      const light = 0.75 + 0.35 * (x / opts.w);
      for (let c = 0; c < 3; c++) {
        const v = sx >= 0 && sy >= 0 && sx < sw && sy < sh ? srcData[(sy * sw + sx) * 4 + c] : bg;
        out[i + c] = v * light + (opts.noise ?? 0) * rnd() * 2;
      }
      out[i + 3] = 255;
    }
  if (opts.blur) boxBlur(out, opts.w, opts.h, opts.blur);
  return out;
}

export function boxBlur(px: Uint8ClampedArray, w: number, h: number, r: number) {
  const tmp = new Float32Array(w * h * 4);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0;
          let n = 0;
          for (let k = -r; k <= r; k++) {
            const xx = pass === 0 ? x + k : x;
            const yy = pass === 0 ? y : y + k;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            s += px[(yy * w + xx) * 4 + c];
            n++;
          }
          tmp[(y * w + x) * 4 + c] = s / n;
        }
    for (let i = 0; i < px.length; i++) if (i % 4 !== 3) px[i] = tmp[i];
  }
}

