// Step-by-step decoder diagnostics against the known drawing:
//   npx vite-node scripts/diagnose.ts [text] [--chat] [--dark] [--photo [--rotated]] [--side=N] [--thread=N]
// Renders one message (or the test conversation with --chat), optionally through the tests' photo
// simulation, then reports markers, chains, and how many vertices of each chain were misread.
import { createCanvas } from '@napi-rs/canvas';
import { readChains, Reader } from '../src/core/decode';
import { binarizeBlocks, findMarkers, toGray } from '../src/core/detect';
import { Conversation, encodeConversation } from '../src/core/encode';
import { GAP_BONDS, GAP_SYMBOLS, GAP_VERTICES } from '../src/core/layout';
import { imageSize, renderConversation, THEMES } from '../src/core/render';
import { flipValue } from '../src/core/shapes';
import { photo } from '../tests/sim';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const text = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : "Göz seni bekliyor. Kuantum Ay'da buluşalım.";
const conv: Conversation = flag('chat')
  ? {
    thread: 0x1234,
    messages: [
      { author: 'Solanum', parent: -1, text: 'Karanlıkta parlayan bir ışık gördük. Yola çıkalım!' },
      { author: 'Feldspar', parent: 0, text: 'Kuantum Ay bize yolu gösterecek.' },
      { author: 'Chert', parent: 0, text: 'Yıldızlar sönüyor; zamanımız az.' },
      { author: 'Gabbro', parent: 1, text: 'Acele etme dostum, döngü yine başlar.' },
    ],
  }
  : { thread: Number(arg('thread') ?? 1), messages: [{ author: 'Solanum', text, parent: -1 }] };
// --dark: dark writing on a light page, which the reader still has to cope with.
const dark = flag('dark');
const theme = dark ? { id: 'dark', name: 'dark', background: '#f3ead7', ink: '#3a2a1a' } : THEMES[0];
const enc = encodeConversation(conv);
const { width, height, scale } = imageSize(enc, Number(arg('side') ?? 1400));
const c = createCanvas(width, height);
renderConversation(c.getContext('2d') as never, enc, scale, theme);
let rgba = c.getContext('2d').getImageData(0, 0, width, height).data;
let W = width;
let H = height;
// --photo: the tests' tilted-photo simulation (padded square, perspective, lighting, blur, noise).
if (flag('photo')) {
  const side = Math.max(width, height);
  const sq = createCanvas(side, side);
  const ctx = sq.getContext('2d');
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(c, (side - width) / 2, (side - height) / 2);
  const k = side / 1200;
  const rotated = flag('rotated');
  W = Math.round((rotated ? 1600 : 1400) * k);
  H = Math.round((rotated ? 1300 : 1100) * k);
  let corners = (rotated ? [[800, 20], [1560, 650], [760, 1280], [40, 650]] : [[150, 60], [1260, 140], [1210, 1070], [110, 1000]])
    .map(([x, y]) => [x * k, y * k] as [number, number]);
  // --tilted-chat: exactly the tests' tilted conversation photo (render with --side=2400).
  if (flag('tilted-chat')) {
    // Exactly the tests' tilted conversation photo (render with --side=4000).
    const t = 1;
    W = 4000;
    H = 3333;
    corners = [[250, 200], [3800, 333], [3717, 3167], [167, 3067]].map(([x, y]) => [x * t, y * t] as [number, number]);
  }
  rgba = photo(sq as never, { w: W, h: H, corners, blur: 1, noise: rotated || flag('tilted-chat') ? 8 : 12 });
}
const gray = toGray(rgba, W, H);
console.log(`${width}x${height} at ${scale.toFixed(2)} px/unit; gaps drawn: ${enc.segments.map((n) => n * 3).join(' ')}`);

const bin = binarizeBlocks(gray, 6, dark);
const markers = findMarkers(bin, W, H);
console.log(`markers found: ${markers.length}`, markers.slice(0, 12).map((m) => `${m.skew.toFixed(2)}/${m.across.toFixed(2)}`).join(" "));
const chains = readChains(gray, bin, dark);
console.log('chains:', chains.map((ch) => ch.gaps.length).join(' '));

const names = ['none', 'stem', 'ring', 'fork'];
for (const chain of chains) {
  const read = chain.gaps.map((gap) => {
    const out: number[] = [];
    for (let j = 0; j < GAP_VERTICES; j++) {
      let best = 0;
      for (let v = 1; v < 16; v++) if (gap[j * 16 + v] > gap[j * 16 + best]) best = v;
      out.push(best);
    }
    return out;
  });
  // Best match among every message's gaps, either way round.
  let found: { msg: number; off: number; flip: boolean; perGap: number[]; r: number[][] } | null = null;
  enc.values.forEach((values, msg) => {
    const drawn = Array.from({ length: enc.segments[msg] * 3 }, (_, g) => Array.from(values.subarray(g * GAP_SYMBOLS, g * GAP_SYMBOLS + GAP_VERTICES)));
    for (const flip of [false, true]) {
      const r = flip ? read.map((g) => g.map(flipValue).reverse()).reverse() : read;
      for (let off = 0; off + r.length <= drawn.length; off++) {
        const perGap = r.map((g, i) => g.filter((v, j) => v !== drawn[off + i][j]).length);
        const wrong = perGap.reduce((a, b) => a + b, 0);
        if (!found || wrong < found.perGap.reduce((a, b) => a + b, 0)) found = { msg, off, flip, perGap, r };
      }
    }
  });
  if (!found) continue;
  const f = found as { msg: number; off: number; flip: boolean; perGap: number[]; r: number[][] };
  const wrong = f.perGap.reduce((a, b) => a + b, 0);
  console.log(`chain of ${read.length}: message ${f.msg} from gap ${f.off}${f.flip ? ' (reversed)' : ''}: ${wrong} wrong, by gap ${f.perGap.join(' ')}`);
  // Bonds: straight or broken, read against drawn.
  let bondWrong = 0;
  chain.gaps.forEach((gap, i) => {
    const k = f.flip ? chain.gaps.length - 1 - i : i;
    for (let b = 0; b < GAP_BONDS; b++) {
      const rb = f.flip ? GAP_BONDS - 1 - b : b;
      const got = gap[GAP_VERTICES * 16 + 2 * rb + 1] > gap[GAP_VERTICES * 16 + 2 * rb] ? 1 : 0;
      const want = enc.values[f.msg][(f.off + k) * GAP_SYMBOLS + GAP_VERTICES + b];
      if (got !== want) bondWrong++;
      if (flag("bonds")) process.stdout.write(`${want ? "B" : "S"}${(gap[GAP_VERTICES * 16 + 2 * rb]).toFixed(2)}${got !== want ? "!" : ""} `);
    }
  });
  console.log(`   bonds wrong: ${bondWrong} of ${chain.gaps.length * GAP_BONDS}`);
  const drawnOf = (g: number) => Array.from(enc.values[f.msg].subarray(g * GAP_SYMBOLS, g * GAP_SYMBOLS + GAP_VERTICES));
  const conf = new Map<string, number>();
  f.r.forEach((g, i) =>
    g.forEach((v, j) => {
      const want = drawnOf(f.off + i)[j];
      if (v === want) return;
      const parts = [];
      if ((v ^ want) & 8) parts.push('armL');
      if ((v ^ want) & 4) parts.push('armR');
      if ((v ^ want) & 3) parts.push(`${names[want & 3]}->${names[v & 3]}`);
      const key = `${parts.join('+')} @${j}`;
      conf.set(key, (conf.get(key) ?? 0) + 1);
    }),
  );
  if (conf.size && !flag('quiet')) console.log('  ', Object.fromEntries(conf));
  console.log('   fits:', chain.fits.map((x) => `${x.phase > 0 ? '+' : '-'}${x.ds.toFixed(1)}/${x.dv.toFixed(1)}/${x.fit.toFixed(2)}`).join(' '));
}
const res = new Reader().addFrame(rgba, W, H);
console.log('messages:', res.messages.map((m) => `#${m.index} ${m.author}: ${m.text}`), 'partial:', res.partial, `${res.ms} ms`);
