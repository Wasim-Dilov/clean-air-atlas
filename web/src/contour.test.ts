import { describe, expect, it } from 'vitest';
import { colourMask, contourLines } from './contour';

const grid = (rows: number[][]) => ({ field: rows.flat(), w: rows[0].length, h: rows.length });

describe('top band outlines', () => {
  it('draws one closed ring around a single high value', () => {
    const { field, w, h } = grid([
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ]);
    const lines = contourLines(field, w, h, 0.5);
    expect(lines).toHaveLength(1);
    const ring = lines[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
    expect(ring).toHaveLength(5); // four edge crossings plus the repeated start
    for (const [x, y] of ring) expect(Math.hypot(x - 1.5, y - 1.5)).toBeCloseTo(0.5); // halfway to each neighbour
  });

  it('interpolates where the field crosses the level', () => {
    const { field, w, h } = grid([
      [0, 4],
      [0, 4],
    ]);
    const [line] = contourLines(field, w, h, 1);
    expect(line.map(([x]) => x)).toEqual([0.75, 0.75]);
    expect(line.map(([, y]) => y).sort()).toEqual([0.5, 1.5]);
  });

  it('draws nothing when the field never crosses the level', () => {
    expect(contourLines([1, 2, 3, 4], 2, 2, 10)).toEqual([]);
    expect(contourLines([1, 2, 3, 4], 2, 2, 0)).toEqual([]);
  });

  it('separates or joins saddle corners by the centre value', () => {
    // Top-left and bottom-right high, the others low; the centre (mean 0.5) decides.
    const field = [1, 0, 0, 1];
    // A line from the top edge (y = 0.5) to the right edge (x = 1.5) cuts off the low top-right corner.
    const cutsTopRight = (lines: [number, number][][]) => lines.some((l) => l.some(([, y]) => y === 0.5) && l.some(([x]) => x === 1.5));
    const joined = contourLines(field, 2, 2, 0.4); // centre above the level: high corners connect
    const apart = contourLines(field, 2, 2, 0.6); // centre below: high corners stay separate
    expect(joined).toHaveLength(2);
    expect(apart).toHaveLength(2);
    expect(cutsTopRight(joined)).toBe(true);
    expect(cutsTopRight(apart)).toBe(false);
  });

  it('skips cells with missing values', () => {
    expect(contourLines([0, 1, NaN, 0], 2, 2, 0.5)).toEqual([]);
  });

  it('finds a colour in an image and softens the mask edge', () => {
    // 3 × 1 image: top-band colour, another colour, a transparent pixel of the top-band colour.
    const rgba = [46, 15, 19, 235, 133, 1, 34, 235, 46, 15, 19, 0];
    const mask = colourMask(rgba, 3, 1, [46, 15, 19]);
    expect(mask[0]).toBeCloseTo(1 / 2);
    expect(mask[1]).toBeCloseTo(1 / 3);
    expect(mask[2]).toBe(0);
  });
});
