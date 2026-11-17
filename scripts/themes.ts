// Renders the sample conversation on every wall with every ink colour: npx vite-node scripts/themes.ts
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'fs';
import { encodeConversation } from '../src/core/encode';
import { imageSize, INKS, renderConversation, WALLS, wallTheme } from '../src/core/render';

mkdirSync('tests/out', { recursive: true });
const enc = encodeConversation({
  thread: 0x4321,
  messages: [
    { author: 'Solanum', parent: -1, text: 'Karanlıkta parlayan bir ışık gördük. Yola çıkalım!' },
    { author: 'Feldspar', parent: 0, text: 'Kuantum Ay bize yolu gösterecek.' },
    { author: 'Chert', parent: 0, text: 'Yıldızlar sönüyor; zamanımız az.' },
    { author: 'Gabbro', parent: 1, text: 'Acele etme dostum, döngü yine başlar.' },
    { author: 'Riebeck', parent: 2, text: 'Kanyonda eski yazılar buldum.' },
  ],
});
for (const wall of WALLS)
  for (const ink of INKS) {
    const { width, height, scale } = imageSize(enc, 1600);
    const c = createCanvas(width, height);
    renderConversation(c.getContext('2d') as never, enc, scale, wallTheme(wall.id, ink.id));
    writeFileSync(`tests/out/theme-${wall.id}-${ink.id}.png`, c.toBuffer('image/png'));
  }
console.log('done');
