import { describe, expect, it } from 'vitest';
import { rsDecode, rsEncode } from '../src/core/rs';
import { decodeText, encodeText } from '../src/core/textcodec';
import { messageSize } from '../src/core/encode';
import { DATA_BYTES } from '../src/core/layout';

describe('reed-solomon', () => {
  it('corrects up to nsym/2 errors', () => {
    const data = Array.from({ length: 40 }, (_, i) => (i * 37 + 11) & 255);
    const block = data.concat(rsEncode(data, 16));
    for (const p of [0, 5, 17, 33, 41, 50, 54, 55]) block[p] ^= 0x5a;
    expect(rsDecode(block, 16)).toEqual(data);
  });

  it('corrects erasures plus errors', () => {
    const data = Array.from({ length: 100 }, (_, i) => (i * 91) & 255);
    const block = data.concat(rsEncode(data, 20));
    const erasures = [1, 2, 3, 4, 60, 61, 62, 63, 99, 110];
    for (const p of erasures) block[p] ^= 0xff;
    for (const p of [20, 30, 40, 50, 70]) block[p] ^= 1;
    expect(rsDecode(block, 20, erasures)).toEqual(data);
  });

  it('rejects too many errors', () => {
    const data = Array.from({ length: 30 }, (_, i) => i);
    const block = data.concat(rsEncode(data, 8));
    for (let p = 0; p < 10; p++) block[p * 3] ^= 0x33;
    expect(() => {
      const out = rsDecode(block, 8);
      if (out.join() !== data.join()) throw new Error('miscorrected');
    }).toThrow();
  });
});

describe('text codec', () => {
  const samples = [
    '',
    'merhaba dünya',
    'Işık İstanbul ÇĞÖŞÜ çğöşü ıi',
    'Solanum: "Evrenin gözü" nerede? 42!',
    'emoji 🚀 fallback',
    'Ω Greek and ąę other',
    'satır\nsatır',
  ];
  for (const s of samples) {
    it(`round-trips ${JSON.stringify(s)}`, () => {
      expect(decodeText(encodeText(s))).toBe(s);
    });
  }

  it('fits a 40-character Turkish message and an author in one spiral', () => {
    const text = 'Gözlerimizi açtığımızda parlayan bir ışık gördük.'.slice(0, 40);
    expect(messageSize({ author: 'Solanum', text, parent: -1 })).toBeLessThanOrEqual(DATA_BYTES);
  });
});
