// Diagnostics: for one message of the test conversation photographed tilted, checks each of its gaps' links.
import { createCanvas } from '@napi-rs/canvas';
import { fitGap, GapCurve } from '../src/core/decode';
import { binarizeBlocks, findMarkers, toGray } from '../src/core/detect';
import { apply, homography } from '../src/core/homography';
import { encodeConversation } from '../src/core/encode';
import { GAP_LEN, pathAt, sequence, toWorld } from '../src/core/layout';
import { imageSize, MARGIN, renderConversation, THEMES } from '../src/core/render';
import { photo } from '../tests/sim';

const msg = Number(process.argv[2] ?? 1);
const enc = encodeConversation({
  thread: 0x1234,
  messages: [
    { author: 'Solanum', parent: -1, text: 'Karanlıkta parlayan bir ışık gördük. Yola çıkalım!' },
    { author: 'Feldspar', parent: 0, text: 'Kuantum Ay bize yolu gösterecek.' },
    { author: 'Chert', parent: 0, text: 'Yıldızlar sönüyor; zamanımız az.' },
    { author: 'Gabbro', parent: 1, text: 'Acele etme dostum, döngü yine başlar.' },
  ],
});
const { width, height, scale } = imageSize(enc, 3000);
const art = createCanvas(width, height);
renderConversation(art.getContext('2d') as never, enc, scale, THEMES[0]);
const side = Math.max(width, height);
const sq = createCanvas(side, side);
const ctx = sq.getContext('2d');
ctx.fillStyle = THEMES[0].background;
ctx.fillRect(0, 0, side, side);
const ox = (side - width) / 2;
const oy = (side - height) / 2;
ctx.drawImage(art, ox, oy);
const corners: [number, number][] = [[188, 150], [2850, 250], [2788, 2375], [125, 2300]];
const W = 3000;
const Hh = 2500;
const px = photo(sq as never, { w: W, h: Hh, corners, blur: 1, noise: 8 });
const toPhoto = homography([{ x: 0, y: 0 }, { x: side, y: 0 }, { x: side, y: side }, { x: 0, y: side }], corners.map(([x, y]) => ({ x, y })));
const node = enc.layout.nodes[msg];
const seq = sequence(enc.segments[msg]);
const truth = seq.markers.map((s) => {
  const p = pathAt(s, node.placement.variant);
  const [x, y] = toWorld(node.placement, p.x, p.y);
  return apply(toPhoto, (x - enc.layout.minX + MARGIN) * scale + ox, (y - enc.layout.minY + MARGIN) * scale + oy);
});
const g = toGray(px, W, Hh);
const bin = binarizeBlocks(g, 6, false);
const found = findMarkers(bin, W, Hh);
const near = truth.map((t) => {
  let best = -1;
  let d = Infinity;
  found.forEach((m, i) => {
    const e = Math.hypot(m.x - t.x, m.y - t.y);
    if (e < d) { d = e; best = i; }
  });
  return { i: best, d };
});
console.log('marker match distances:', near.map((n) => n.d.toFixed(1)).join(' '));
for (let k = 0; k + 1 < truth.length; k++) {
  const A = found[near[k].i];
  const B = found[near[k + 1].i];
  const dist = Math.hypot(B.x - A.x, B.y - A.y);
  const S = (GAP_LEN * (A.scale + B.scale)) / 2;
  const fit = fitGap(bin, W, Hh, new GapCurve(A, B));
  const ang = (m: typeof A, dx: number, dy: number) => {
    const c = Math.abs(m.tx * dx + m.ty * dy) / Math.hypot(dx, dy);
    return Math.acos(Math.min(1, c)).toFixed(2);
  };
  console.log(`gap ${k}: scales ${A.scale.toFixed(2)}/${B.scale.toFixed(2)} dist/S ${(dist / S).toFixed(2)} angles ${ang(A, B.x - A.x, B.y - A.y)} ${ang(B, B.x - A.x, B.y - A.y)} fit ${fit ? `${fit.phase} ${fit.fit.toFixed(2)}` : 'none'}`);
}
