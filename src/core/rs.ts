// Reed-Solomon over GF(256), primitive polynomial 0x11d, first consecutive root α^0.
// Polynomials are arrays with the highest-degree coefficient first.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a: number, b: number) => {
  if (b === 0) throw new Error('GF division by zero');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const pow = (a: number, p: number) => EXP[(((LOG[a] * p) % 255) + 255) % 255];
const inv = (a: number) => EXP[255 - LOG[a]];

function polyScale(p: number[], x: number): number[] {
  return p.map((c) => mul(c, x));
}

function polyAdd(p: number[], q: number[]): number[] {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
  return r;
}

function polyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  }
  return r;
}

function polyEval(p: number[], x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function polyDivRemainder(dividend: number[], divisor: number[]): number[] {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < divisor.length; j++) {
      if (divisor[j] !== 0) out[i + j] ^= mul(divisor[j], coef);
    }
  }
  return out.slice(out.length - (divisor.length - 1));
}

const generatorCache = new Map<number, number[]>();
function generator(nsym: number): number[] {
  let g = generatorCache.get(nsym);
  if (!g) {
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
    generatorCache.set(nsym, g);
  }
  return g;
}

/** Returns the `nsym` parity bytes for `data`. */
export function rsEncode(data: ArrayLike<number>, nsym: number): number[] {
  if (data.length + nsym > 255) throw new Error('RS block too long');
  const gen = generator(nsym);
  const out = new Array(data.length + nsym).fill(0);
  for (let i = 0; i < data.length; i++) out[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  return out.slice(data.length);
}

function syndromes(msg: number[], nsym: number): number[] {
  const s = [0];
  for (let i = 0; i < nsym; i++) s.push(polyEval(msg, pow(2, i)));
  return s;
}

function forneySyndromes(synd: number[], erasePos: number[], n: number): number[] {
  const fsynd = synd.slice(1);
  for (const p of erasePos) {
    const x = pow(2, n - 1 - p);
    for (let j = 0; j < fsynd.length - 1; j++) fsynd[j] = mul(fsynd[j], x) ^ fsynd[j + 1];
  }
  return fsynd;
}

function errorLocator(synd: number[], nsym: number, eraseCount: number): number[] {
  // Berlekamp-Massey
  let errLoc = [1];
  let oldLoc = [1];
  for (let i = 0; i < nsym - eraseCount; i++) {
    let delta = synd[i];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], synd[i - j]);
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 + eraseCount > nsym) throw new Error('Too many errors');
  return errLoc;
}

function findErrors(errLocReversed: number[], n: number): number[] {
  const errs = errLocReversed.length - 1;
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    if (polyEval(errLocReversed, pow(2, i)) === 0) pos.push(n - 1 - i);
  }
  if (pos.length !== errs) throw new Error('Chien search failed');
  return pos;
}

function correctErrata(msg: number[], synd: number[], errPos: number[]): number[] {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  let errLoc = [1];
  for (const c of coefPos) errLoc = polyMul(errLoc, polyAdd([1], [pow(2, c), 0]));
  const nsymLoc = errLoc.length - 1;
  const errEval = polyDivRemainder(
    polyMul(synd.slice().reverse(), errLoc),
    [1].concat(new Array(nsymLoc + 1).fill(0)),
  );
  const X = coefPos.map((c) => pow(2, c));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xiInv = inv(X[i]);
    let locPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) locPrime = mul(locPrime, 1 ^ mul(xiInv, X[j]));
    }
    if (locPrime === 0) throw new Error('Could not find error magnitude');
    const y = mul(X[i], polyEval(errEval, xiInv));
    E[errPos[i]] = div(y, locPrime);
  }
  return polyAdd(msg, E);
}

/**
 * Corrects a received block (data + parity) in place-free fashion.
 * Returns the corrected data bytes, or throws if the block is unrecoverable.
 */
export function rsDecode(block: ArrayLike<number>, nsym: number, erasePos: number[] = []): number[] {
  const msg = Array.from(block);
  for (const p of erasePos) msg[p] = 0;
  if (erasePos.length > nsym) throw new Error('Too many erasures');
  const synd = syndromes(msg, nsym);
  if (synd.every((s) => s === 0)) return msg.slice(0, msg.length - nsym);
  const fsynd = forneySyndromes(synd, erasePos, msg.length);
  const errLoc = errorLocator(fsynd, nsym, erasePos.length);
  const errPos = findErrors(errLoc.slice().reverse(), msg.length);
  const fixed = correctErrata(msg, synd, erasePos.concat(errPos));
  if (syndromes(fixed, nsym).some((s) => s !== 0)) throw new Error('Correction failed');
  return fixed.slice(0, fixed.length - nsym);
}
