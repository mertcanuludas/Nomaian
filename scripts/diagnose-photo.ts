// Detector diagnostics on a saved image: npx vite-node scripts/diagnose-photo.ts tests/out/photo-x.png
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readChains, Reader } from '../src/core/decode';
import { binarize, binarizeBlocks, findMarkers, toGray } from '../src/core/detect';

const file = process.argv[2];
const img = await loadImage(file);
const c = createCanvas(img.width, img.height);
c.getContext('2d').drawImage(img, 0, 0);
const rgba = c.getContext('2d').getImageData(0, 0, img.width, img.height).data;
const gray = toGray(rgba, img.width, img.height);
const minDim = Math.min(img.width, img.height);
const methods: Record<string, (dark: boolean) => Uint8Array> = {
  block6: (d) => binarizeBlocks(gray, 6, d),
  block12: (d) => binarizeBlocks(gray, 12, d),
  mean: (d) => binarize(gray, minDim / 8, d),
};
for (const darkInk of [true, false])
  for (const [name, fn] of Object.entries(methods)) {
    const bin = fn(darkInk);
    const markers = findMarkers(bin, img.width, img.height);
    const chains = readChains(gray, bin, darkInk);
    console.log(
      `dark=${darkInk} ${name}: ${markers.length} markers (scale ${(markers.reduce((s, m) => s + m.scale, 0) / (markers.length || 1)).toFixed(2)}), chains of ${chains.map((ch) => ch.gaps.length).join(' ') || '-'} gaps`,
    );
  }
const r = new Reader().addFrame(rgba, img.width, img.height);
console.log('messages:', r.messages.map((m) => `#${m.index} ${m.author}: ${m.text}`));
console.log('partial:', r.partial);
