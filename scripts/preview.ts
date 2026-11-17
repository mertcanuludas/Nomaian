// Renders a sample conversation to tests/out for eyeballing: npx vite-node scripts/preview.ts
import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'fs';
import { Conversation, encodeConversation, messageSize } from '../src/core/encode';
import { DATA_BYTES, sequence } from '../src/core/layout';
import { imageSize, renderConversation, THEMES } from '../src/core/render';

mkdirSync('tests/out', { recursive: true });
const conversation: Conversation = {
  thread: 0x1234,
  messages: [
    { author: 'Solanum', parent: -1, text: 'Karanlıkta parlayan bir ışık gördük. Kaynağını bulmak için yola çıkalım!' },
    { author: 'Feldspar', parent: 0, text: 'Kuantum Ay bize yolu gösterecek.' },
    { author: 'Chert', parent: 0, text: 'Yıldızlar sönüyor; zamanımız az.' },
    { author: 'Gabbro', parent: 1, text: 'Acele etme dostum.' },
  ],
};
for (const m of conversation.messages) console.log(m.author, m.text.length, 'chars ->', messageSize(m), '/', DATA_BYTES, 'bytes');

for (const n of [1, conversation.messages.length]) {
  const enc = encodeConversation({ ...conversation, messages: conversation.messages.slice(0, n) });
  console.log('segments', enc.segments.join(' '), 'arcs', enc.segments.map((k) => sequence(k).len.toFixed(0)).join(' '));
  for (const theme of THEMES) {
    const { width, height, scale } = imageSize(enc);
    const c = createCanvas(width, height);
    renderConversation(c.getContext('2d') as never, enc, scale, theme);
    writeFileSync(`tests/out/preview-${n}-${theme.id}.png`, c.toBuffer('image/png'));
    console.log(`preview-${n}-${theme.id}: ${width}x${height}`);
  }
}
