/**
 * Outlines for the near-black top band. Near-black barely differs from the dark base map,
 * so its areas get a thin light outline, drawn as vector lines that stay sharp at any zoom.
 *
 * Marching squares on a grid of values: lines run where the field crosses a level, with
 * positions interpolated along cell edges. Pixel coordinates put sample (i, j) at (i + 0.5, j + 0.5).
 */

export type Line = [number, number][];

// Edges of a cell, named by side; each case lists the pairs of sides a segment joins.
const T = 0;
const R = 1;
const B = 2;
const L = 3;
const CASES: number[][][] = [
  [], [[L, B]], [[B, R]], [[L, R]], [[T, R]], [], [[T, B]], [[L, T]],
  [[L, T]], [[T, B]], [], [[T, R]], [[L, R]], [[B, R]], [[L, B]], [],
];

/** Line strips where `field` (w × h, row-major) crosses `level`. Cells with a NaN corner are skipped. */
export function contourLines(field: ArrayLike<number>, w: number, h: number, level = 0): Line[] {
  const points = new Map<number, [number, number]>();
  const segs: [number, number][] = [];
  const hKey = (x: number, y: number) => (y * w + x) * 2; // edge from (x, y) to (x + 1, y)
  const vKey = (x: number, y: number) => (y * w + x) * 2 + 1; // edge from (x, y) to (x, y + 1)
  const cross = (k: number, x0: number, y0: number, x1: number, y1: number, v0: number, v1: number) => {
    if (points.has(k)) return;
    const t = v1 === v0 ? 0.5 : (level - v0) / (v1 - v0);
    points.set(k, [x0 + (x1 - x0) * t + 0.5, y0 + (y1 - y0) * t + 0.5]);
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = field[y * w + x];
      const b = field[y * w + x + 1];
      const c = field[(y + 1) * w + x + 1];
      const d = field[(y + 1) * w + x];
      if (Number.isNaN(a + b + c + d)) continue;
      const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const side = (s: number): number => {
        switch (s) {
          case T: cross(hKey(x, y), x, y, x + 1, y, a, b); return hKey(x, y);
          case R: cross(vKey(x + 1, y), x + 1, y, x + 1, y + 1, b, c); return vKey(x + 1, y);
          case B: cross(hKey(x, y + 1), x, y + 1, x + 1, y + 1, d, c); return hKey(x, y + 1);
          default: cross(vKey(x, y), x, y, x, y + 1, a, d); return vKey(x, y);
        }
      };
      let pairs = CASES[code];
      if (code === 5 || code === 10) {
        // Saddle: the centre value decides which diagonal is connected.
        const centreIn = (a + b + c + d) / 4 > level;
        const cutAC = (code === 5) === centreIn; // cut off corners a and c, or b and d
        pairs = cutAC ? [[L, T], [B, R]] : [[T, R], [L, B]];
      }
      for (const [s0, s1] of pairs) segs.push([side(s0), side(s1)]);
    }
  }
  return chain(segs, points);
}

/** Join segments that share an edge crossing into longer strips (closed rings repeat their start). */
function chain(segs: [number, number][], points: Map<number, [number, number]>): Line[] {
  const at = new Map<number, number[]>();
  segs.forEach(([p, q], i) => {
    for (const k of [p, q]) {
      const list = at.get(k);
      if (list) list.push(i);
      else at.set(k, [i]);
    }
  });
  const used = new Uint8Array(segs.length);
  const next = (k: number): number => (at.get(k) ?? []).find((i) => !used[i]) ?? -1;
  const lines: Line[] = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const keys = [segs[s][0], segs[s][1]];
    // Extend forwards from the end, then backwards from the start.
    for (let i = next(keys[keys.length - 1]); i >= 0; i = next(keys[keys.length - 1])) {
      used[i] = 1;
      const [p, q] = segs[i];
      keys.push(p === keys[keys.length - 1] ? q : p);
    }
    for (let i = next(keys[0]); i >= 0; i = next(keys[0])) {
      used[i] = 1;
      const [p, q] = segs[i];
      keys.unshift(p === keys[0] ? q : p);
    }
    lines.push(keys.map((k) => points.get(k)!));
  }
  return lines;
}

/** 1 where a pixel shows the given colour (within a small tolerance), else 0, softened by a 3 × 3 box blur. */
export function colourMask(rgba: ArrayLike<number>, w: number, h: number, rgb: readonly [number, number, number], tol = 8): Float32Array {
  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    raw[i] = rgba[o + 3] > 0 && Math.abs(rgba[o] - rgb[0]) <= tol && Math.abs(rgba[o + 1] - rgb[1]) <= tol && Math.abs(rgba[o + 2] - rgb[2]) <= tol ? 1 : 0;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += raw[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}
