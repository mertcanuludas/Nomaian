import { createCanvas, Image } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { DecodedMessage, decodeImage, Reader } from '../src/core/decode';
import { Conversation, encodeConversation, messageSize, segmentsFor } from '../src/core/encode';
import { BAND, DATA_BYTES, VARIANTS, GAP_LEN, layoutConversation, MAX_SCALE, MAX_SEGMENTS, NECK, pathAt, PORTS, sequence, stalkPath, STROKE, toWorld } from '../src/core/layout';
import { imageSize, MARGIN, renderConversation, Theme, THEMES } from '../src/core/render';
import { TEMPLATES } from '../src/core/shapes';
import { boxBlur, photo } from './sim';

const OUT = 'tests/out';
/**
 * Every spiral is drawn about as big as the longest message needs, so a picture of one takes this many
 * times more pixels than when short messages made small spirals; image sizes below are scaled by it.
 */
const GROW = 1.5;
const big = (n: number) => Math.round(n * GROW);
const bigCorners = (cs: number[][]) => cs.map(([x, y]) => [big(x), big(y)] as [number, number]);
/** Dark writing on a light page: the app no longer offers it, but the reader still has to cope with it. */
const DARK_INK: Theme = { id: 'dark-ink', name: 'Koyu mürekkep', background: '#f3ead7', ink: '#3a2a1a' };
mkdirSync(OUT, { recursive: true });

const SINGLE: Conversation = {
  thread: 0x2a17,
  messages: [{ author: 'Solanum', parent: -1, text: 'Merhaba gezgin! Göz seni bekliyor.' }],
};

/** The longest message there is room for: the biggest spiral. */
const LONG: Conversation = {
  thread: 0x0b0e,
  messages: [{ author: 'Solanum', parent: -1, text: 'Karanlıkta parlayan bir ışık gördük. Kaynağını bulmak için yola çıkalım!' }],
};

const CHAT: Conversation = {
  thread: 0x1234,
  messages: [
    { author: 'Solanum', parent: -1, text: 'Karanlıkta parlayan bir ışık gördük. Yola çıkalım!' },
    { author: 'Feldspar', parent: 0, text: 'Kuantum Ay bize yolu gösterecek.' },
    { author: 'Chert', parent: 0, text: 'Yıldızlar sönüyor; zamanımız az.' },
    { author: 'Gabbro', parent: 1, text: 'Acele etme dostum, döngü yine başlar.' },
  ],
};

function render(conv: Conversation, maxSide: number, theme: Theme = THEMES[0]) {
  const enc = encodeConversation(conv);
  const { width, height, scale } = imageSize(enc, maxSide);
  const canvas = createCanvas(width, height);
  renderConversation(canvas.getContext('2d') as never, enc, scale, theme);
  return { canvas, enc, scale };
}

type Canvas = ReturnType<typeof render>['canvas'];

function save(name: string, rgba: Uint8ClampedArray, w: number, h: number) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);
  writeFileSync(`${OUT}/${name}.png`, c.toBuffer('image/png'));
}

const pixels = (c: Canvas) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;

/** Decoded messages as comparable records, by index. */
function simplify(msgs: DecodedMessage[]) {
  return msgs
    .map(({ thread, index, parent, total, author, text }) => ({ thread, index, parent, total, author, text }))
    .sort((a, b) => a.index - b.index);
}

function expected(conv: Conversation, only?: number[]) {
  return conv.messages
    .map((m, index) => ({ thread: conv.thread, index, parent: m.parent, total: conv.messages.length, author: m.author, text: m.text }))
    .filter((m) => !only || only.includes(m.index));
}

describe('layout', () => {
  it('substituent templates are mutually distinct', () => {
    TEMPLATES.forEach((T, j) => {
      for (let a = 0; a < T.length; a++)
        for (let b = a + 1; b < T.length; b++) {
          const dot = T[a].reduce((s, x, i) => s + x * T[b][i], 0);
          expect(dot, `vertex ${j}, values ${a} & ${b}`).toBeLessThan(0.92);
        }
    });
  });

  it('keeps spirals and their stalks apart in branching threads', () => {
    // A 12-message thread where messages get one to three replies, breadth first.
    const parents = [-1, 0, 0, 0, 1, 1, 2, 3, 3, 3, 4, 6];
    // No bands of writing may touch: neither spirals nor the dressed part of stalks (only a stalk's own reply
    // continues it).
    for (const seed of [1, 2, 3]) {
      const nodes = layoutConversation(parents, parents.map((_, i) => 1 + (i % MAX_SEGMENTS)), seed).nodes;
      const spirals = nodes.map((n) => {
        const pts: Array<[number, number]> = [];
        for (let s = 0; s <= n.len; s += 6) {
          const p = pathAt(s, n.placement.variant);
          pts.push(toWorld(n.placement, p.x, p.y));
        }
        return pts;
      });
      const stalks = nodes.map((n) => {
        const pts: Array<[number, number]> = [];
        if (!n.stalk) return pts;
        const { map } = stalkPath(n.stalk);
        for (let s = 0; s <= (n.dressed ?? 0); s += 6) pts.push(map(s, 0));
        return pts;
      });
      const apart = (a: Array<[number, number]>, b: Array<[number, number]>) => {
        let d = Infinity;
        for (const p of a) for (const q of b) d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1]));
        return d;
      };
      const min = 2 * (BAND + STROKE) * MAX_SCALE;
      for (let a = 0; a < nodes.length; a++)
        for (let b = 0; b < nodes.length; b++) {
          if (a < b) expect(apart(spirals[a], spirals[b]), `seed ${seed}: spirals ${a} & ${b}`).toBeGreaterThan(min);
          if (a < b) expect(apart(stalks[a], stalks[b]), `seed ${seed}: stalks ${a} & ${b}`).toBeGreaterThan(min);
          // A stalk branches off its parent, so its writing may come as close as the parent's band allows.
          const limit = b === parents[a] ? NECK * nodes[b].placement.scale - 7 : min;
          if (a !== b) expect(apart(stalks[a], spirals[b]), `seed ${seed}: stalk ${a} & spiral ${b}`).toBeGreaterThan(limit);
        }
    }
  }, 120000);

  it(`allows at most ${PORTS} replies per message`, () => {
    const parents = [-1, ...new Array(PORTS + 1).fill(0)];
    expect(() => layoutConversation(parents, parents.map(() => 1))).toThrow();
  });
});

describe('render -> decode', () => {
  it('reads a message close to the size limit', () => {
    // As long as a message may be: it takes every segment there is.
    const text = 'We do not have much connection, you and I. This encounter feels special. I hope you won’t mind if I call you friend. Go on!';
    const conv: Conversation = { thread: 0x0077, messages: [{ author: 'Solanum', parent: -1, text }] };
    expect(messageSize(conv.messages[0])).toBeLessThanOrEqual(DATA_BYTES);
    expect(segmentsFor(messageSize(conv.messages[0]))).toBe(MAX_SEGMENTS);
    const { canvas: c } = render(conv, 2000);
    expect(simplify(decodeImage(pixels(c), c.width, c.height))).toEqual(expected(conv));
  }, 60000);

  it('draws spirals of about the same size, a short message written over and over to fill its own', () => {
    const conv: Conversation = {
      thread: 0x0078,
      messages: [
        { author: 'A', parent: -1, text: 'Selam!' },
        { author: 'Solanum', parent: 0, text: 'We do not have much connection, you and I. This encounter feels special.' },
      ],
    };
    const enc = encodeConversation(conv);
    const sizes = enc.layout.nodes.map((n) => {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let s = -VARIANTS[n.placement.variant].lead; s <= n.len; s += 8) {
        const p = pathAt(s, n.placement.variant);
        const [x, y] = toWorld(n.placement, p.x, p.y);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      return Math.sqrt((x1 - x0) * (y1 - y0));
    });
    expect(Math.max(...sizes) / Math.min(...sizes)).toBeLessThan(1.3);
    // The short one takes a single segment of its own, and is drawn over and over.
    expect(enc.segments[0]).toBeGreaterThan(1);
    const { canvas: c } = render(conv, 3000);
    expect(simplify(decodeImage(pixels(c), c.width, c.height))).toEqual(expected(conv));
  }, 120000);

  for (const theme of [THEMES[0], DARK_INK]) {
    it(`clean ${theme.id} single`, () => {
      const { canvas: c } = render(SINGLE, big(1100), theme);
      writeFileSync(`${OUT}/clean-${theme.id}-single.png`, c.toBuffer('image/png'));
      expect(simplify(decodeImage(pixels(c), c.width, c.height))).toEqual(expected(SINGLE));
    });

    it(`clean ${theme.id} conversation`, () => {
      const { canvas: c } = render(CHAT, big(2400), theme);
      writeFileSync(`${OUT}/clean-${theme.id}-chat.png`, c.toBuffer('image/png'));
      expect(simplify(decodeImage(pixels(c), c.width, c.height))).toEqual(expected(CHAT));
    });
  }

  const cases: Array<{
    name: string; conv: Conversation; side: number; w: number; h: number; corners: [number, number][]; blur?: number; noise?: number;
  }> = [
    { name: 'tilted-single', conv: SINGLE, side: big(1200), w: big(1400), h: big(1100), corners: bigCorners([[150, 60], [1260, 140], [1210, 1070], [110, 1000]]), blur: 1, noise: 12 },
    { name: 'rotated-single', conv: SINGLE, side: big(1200), w: big(1600), h: big(1300), corners: bigCorners([[800, 20], [1560, 650], [760, 1280], [40, 650]]), blur: 1, noise: 8 },
    { name: 'small-single', conv: SINGLE, side: big(1000), w: big(1400), h: big(1100), corners: bigCorners([[330, 160], [1110, 190], [1090, 960], [310, 930]]), blur: 1, noise: 10 },
    // Replies spread out to either side, so a conversation is wide: it takes a bigger photo than a single spiral.
    { name: 'tilted-chat', conv: CHAT, side: big(2600), w: big(2600), h: big(2167), corners: bigCorners([[163, 130], [2470, 216], [2416, 2059], [109, 1994]]), blur: 1, noise: 8 },
  ];
  for (const tc of cases) {
    it(`photo ${tc.name}`, () => {
      // The warp maps the image onto a quadrilateral; pad it square first so it is not stretched.
      const { canvas: art } = render(tc.conv, tc.side);
      const side = Math.max(art.width, art.height);
      const src = createCanvas(side, side);
      const sctx = src.getContext('2d');
      sctx.fillStyle = THEMES[0].background;
      sctx.fillRect(0, 0, side, side);
      sctx.drawImage(art, (side - art.width) / 2, (side - art.height) / 2);
      const px = photo(src as Canvas, tc);
      save(`photo-${tc.name}`, px, tc.w, tc.h);
      expect(simplify(decodeImage(px, tc.w, tc.h))).toEqual(expected(tc.conv));
    }, 240000);
  }

  it('reads a spiral panned across piece by piece, none of the pieces enough on its own', () => {
    // The biggest spiral, filmed from close up while the camera follows the writing: each frame shows about
    // three gaps of it, a little turned and zoomed, as a hand would hold it.
    const { canvas: src, enc, scale } = render(LONG, 3000);
    const node = enc.layout.nodes[0];
    const seq = sequence(enc.segments[0]);
    const toImage = (s: number) => {
      const p = pathAt(s, node.placement.variant);
      const [x, y] = toWorld(node.placement, p.x, p.y);
      return [(x - enc.layout.minX + MARGIN) * scale, (y - enc.layout.minY + MARGIN) * scale];
    };
    const side = Math.round(3.2 * GAP_LEN * node.placement.scale * scale);
    const zoom = 1.2;
    const reader = new Reader();
    const alone: number[] = [];
    let frames = 0;
    for (let s = seq.markers[0]; s <= seq.markers[seq.markers.length - 1]; s += 0.8 * GAP_LEN) {
      const [cx, cy] = toImage(s);
      const c = createCanvas(Math.round(side * zoom), Math.round(side * zoom));
      const ctx = c.getContext('2d');
      ctx.fillStyle = THEMES[0].background;
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate(0.3 * Math.sin(frames));
      ctx.scale(zoom, zoom);
      ctx.drawImage(src, -cx, -cy);
      const px = pixels(c);
      boxBlur(px, c.width, c.height, 1);
      if (frames === 6) save('pan-frame', px, c.width, c.height);
      alone.push(decodeImage(px, c.width, c.height).length);
      // A live scan runs one thresholding pass per frame.
      reader.addFrame(px, c.width, c.height, { passes: [frames % 3], now: frames * 150 });
      frames++;
    }
    console.log(`pan: ${frames} frames, read alone: ${alone.join('')}, partial ${JSON.stringify(reader.partial())}`);
    expect(alone.every((n) => n === 0)).toBe(true);
    expect(simplify(reader.messages())).toEqual(expected(LONG));
  }, 180000);

  it('reads the spirals that are in frame when only part of a conversation is photographed', () => {
    const { canvas: src, enc, scale } = render(CHAT, big(2400));
    // Frame the spirals of the two replies to the opening message, cropping the rest.
    const pts = [1, 2].flatMap((i) => {
      const n = enc.layout.nodes[i];
      const out: Array<[number, number]> = [];
      for (let s = 0; s <= n.len; s += 20) {
        const p = pathAt(s, n.placement.variant);
        out.push(toWorld(n.placement, p.x, p.y));
      }
      return out;
    });
    const pad = BAND * 1.5;
    const x0 = (Math.min(...pts.map((p) => p[0])) - pad - enc.layout.minX + MARGIN) * scale;
    const y0 = (Math.min(...pts.map((p) => p[1])) - pad - enc.layout.minY + MARGIN) * scale;
    const x1 = (Math.max(...pts.map((p) => p[0])) + pad - enc.layout.minX + MARGIN) * scale;
    const y1 = (Math.max(...pts.map((p) => p[1])) + pad - enc.layout.minY + MARGIN) * scale;
    const w = Math.round(x1 - x0);
    const h = Math.round(y1 - y0);
    const c = createCanvas(w, h);
    c.getContext('2d').drawImage(src, -x0, -y0);
    writeFileSync(`${OUT}/photo-partial.png`, c.toBuffer('image/png'));
    const got = simplify(decodeImage(pixels(c), w, h));
    expect(got.filter((m) => m.index === 1 || m.index === 2)).toEqual(expected(CHAT, [1, 2]));
  }, 240000);

  it('collects a conversation printed around a cylinder from frames of a pan', () => {
    const { canvas: src } = render(CHAT, big(2400), DARK_INK);
    const sw = src.width;
    const sh = src.height;
    const srcData = pixels(src);
    // Each frame sees about 70 degrees of the cylinder either way, so its edges are visibly foreshortened.
    const R = 600;
    const w = 1400;
    const h = sh + 100;
    const cx = w / 2;
    const reader = new Reader();
    let frames = 0;
    // About eight steps across, however wide the conversation came out.
    const step = Math.round(sw / 8);
    for (let centre = 0; centre <= sw; centre += step) {
      const px = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const d = (x - cx) / R;
          let v = [90, 80, 70];
          if (Math.abs(d) < 1) {
            const sx = Math.round(centre + R * Math.asin(d));
            const sy = y - 50;
            // Light falls off towards the cylinder's edges.
            const shade = 0.55 + 0.45 * Math.sqrt(1 - d * d);
            if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) v = [0, 1, 2].map((c) => srcData[(sy * sw + sx) * 4 + c] * shade);
            else v = v.map((c) => c * 2 * shade);
          }
          px[i] = v[0];
          px[i + 1] = v[1];
          px[i + 2] = v[2];
          px[i + 3] = 255;
        }
      boxBlur(px, w, h, 1);
      if (frames === 3) save('photo-cylinder', px, w, h);
      reader.addFrame(px, w, h, { now: frames * 200 });
      frames++;
    }
    console.log(`cylinder: ${reader.messages().length} messages from ${frames} frames, partial ${JSON.stringify(reader.partial())}`);
    expect(simplify(reader.messages())).toEqual(expected(CHAT));
  }, 180000);

  it('returns nothing quickly for images without a glyph', () => {
    const w = 1600;
    const h = 1200;
    const px = new Uint8ClampedArray(w * h * 4);
    let seed = 7;
    for (let i = 0; i < px.length; i++) px[i] = (seed = (seed * 48271) % 2147483647) & 255;
    const t0 = Date.now();
    expect(decodeImage(px, w, h)).toEqual([]);
    console.log(`no-glyph decode: ${Date.now() - t0} ms`);
  });

  it('survives JPEG', async () => {
    const { canvas: src } = render(CHAT, big(2400), DARK_INK);
    const jpg = await src.encode('jpeg', 60);
    const img = new Image();
    img.src = jpg;
    const c = createCanvas(img.width, img.height);
    c.getContext('2d').drawImage(img, 0, 0);
    expect(simplify(decodeImage(pixels(c), c.width, c.height))).toEqual(expected(CHAT));
  }, 240000);
});
