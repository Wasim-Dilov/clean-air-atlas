import { describe, expect, it } from 'vitest';
import { facesViewer, speedAndFrom, WindField, type WindMeta } from './wind';

const meta: WindMeta = {
  source: 'test', cycle: '', step_h: 0, valid: '', width: 4, height: 3,
  lat0: 60, dlat: 60, lon0: 0, dlon: 90, u: { min: -10, max: 10 }, v: { min: -10, max: 10 }, max_speed: 10,
};

function pixels(fn: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(meta.width * meta.height * 4);
  for (let y = 0; y < meta.height; y++)
    for (let x = 0; x < meta.width; x++) {
      const [r, g, a] = fn(x, y);
      out.set([r, g, 0, a], (y * meta.width + x) * 4);
    }
  return out;
}

describe('wind field', () => {
  it('decodes the scaling written by the pipeline', () => {
    const f = new WindField(meta, pixels(() => [255, 0, 255]));
    const uv = f.sample(45, 30)!;
    expect(uv[0]).toBeCloseTo(10);
    expect(uv[1]).toBeCloseTo(-10);
  });

  it('interpolates across the date line', () => {
    const f = new WindField(meta, pixels((x) => [x === 3 ? 255 : 0, 128, 255]));
    // halfway between column 3 (270°E, u=10) and column 0 (0°E, u=-10)
    expect(f.sample(-45, 0)![0]).toBeCloseTo(0, 0);
  });

  it('returns null outside the grid or where data is missing', () => {
    const f = new WindField(meta, pixels((x) => [128, 128, x === 1 ? 0 : 255]));
    expect(f.sample(0, 80)).toBeNull();
    expect(f.sample(100, 0)).toBeNull();
    expect(f.sample(-45, 0)).not.toBeNull(); // columns 3 and 0 both have data
  });

  it('rejects an image that does not match its metadata', () => {
    expect(() => new WindField(meta, new Uint8Array(8))).toThrow();
  });
});

describe('wind helpers', () => {
  it('reports where the wind comes from', () => {
    expect(speedAndFrom(0, -5)).toMatchObject({ speed: 5, from: 'N' }); // blowing south, from the north
    expect(speedAndFrom(3, 3).from).toBe('SW');
  });

  it('hides points on the far side of the globe', () => {
    expect(facesViewer(10, 20, 10, 20)).toBe(true);
    expect(facesViewer(-170, -20, 10, 20)).toBe(false);
  });
});
