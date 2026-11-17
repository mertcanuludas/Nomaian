export type Pt = { x: number; y: number };
export type Homography = number[]; // 3x3 row-major, h[8] = 1

/** Solves for H mapping each src[i] to dst[i] (exactly 4 correspondences). */
export function homography(src: Pt[], dst: Pt[]): Homography {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) throw new Error('degenerate homography');
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  h.push(1);
  return h;
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error('singular');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Similarity transform that centres points and scales their mean distance to √2. */
function normalizer(pts: Pt[]): number[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / pts.length || 1;
  const k = Math.SQRT2 / d;
  return [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1];
}

function mul3(a: number[], b: number[]): number[] {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

/** Least-squares homography from >= 4 correspondences (normalised DLT, h8 = 1). */
export function fitHomography(src: Pt[], dst: Pt[]): Homography {
  if (src.length === 4) return homography(src, dst);
  const Ts = normalizer(src);
  const Td = normalizer(dst);
  const ATA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const ATb = new Array(8).fill(0);
  for (let i = 0; i < src.length; i++) {
    const s = apply(Ts, src[i].x, src[i].y);
    const d = apply(Td, dst[i].x, dst[i].y);
    const rows: Array<[number[], number]> = [
      [[s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y], d.x],
      [[0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y], d.y],
    ];
    for (const [row, rhs] of rows) {
      for (let a = 0; a < 8; a++) {
        ATb[a] += row[a] * rhs;
        for (let b = 0; b < 8; b++) ATA[a][b] += row[a] * row[b];
      }
    }
  }
  const hn = [...solve(ATA, ATb), 1];
  // H = Td^-1 * Hn * Ts; Td is a similarity so its inverse is easy.
  const k = Td[0];
  const TdInv = [1 / k, 0, -Td[2] / k, 0, 1 / k, -Td[5] / k, 0, 0, 1];
  const H = mul3(mul3(TdInv, hn), Ts);
  return H.map((v) => v / H[8]);
}

export function apply(h: Homography, x: number, y: number): Pt {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}
