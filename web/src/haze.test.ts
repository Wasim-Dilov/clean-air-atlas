import { describe, expect, it } from 'vitest';
import { colorizeHaze, mercatorXY, splat } from './haze';

describe('station zones', () => {
  it('places points on a Web Mercator world image', () => {
    expect(mercatorXY(0, 0, 512)).toEqual([256, 256]);
    expect(mercatorXY(-180, 0, 512)[0]).toBe(0);
    expect(mercatorXY(90, 0, 512)[0]).toBe(384);
    const [, yNorth] = mercatorXY(0, 60, 512);
    expect(yNorth).toBeLessThan(256);
  });

  it('gives the station value at the station and fades with distance', () => {
    const size = 64;
    const { num, den } = splat([{ lon: 0, lat: 0, v: 40 }], size, 2);
    const at = (x: number, y: number) => y * size + x;
    expect(den[at(32, 32)]).toBeCloseTo(1);
    expect(num[at(32, 32)] / den[at(32, 32)]).toBeCloseTo(40);
    expect(den[at(34, 32)]).toBeLessThan(den[at(33, 32)]);
    expect(den[at(32 + 7, 32)]).toBe(0); // beyond 3 sigma
  });

  it('averages nearby stations instead of adding them up', () => {
    const { num, den } = splat([{ lon: 0, lat: 0, v: 10 }, { lon: 0.0001, lat: 0, v: 30 }], 64, 2);
    const i = 32 * 64 + 32;
    expect(num[i] / den[i]).toBeCloseTo(20, 1);
  });

  it('wraps across the date line', () => {
    const size = 64;
    const { den } = splat([{ lon: 179.9, lat: 0, v: 5 }], size, 2);
    expect(den[32 * size + 1]).toBeGreaterThan(0); // spills onto the left edge
  });

  it('colours by WHO band and stays clear far from stations', () => {
    const num = new Float32Array([0, 10, 40, 40]);
    const den = new Float32Array([0.05, 1, 1, 0.2]);
    const px = colorizeHaze(num, den, {
      edges: [15, 25], ramp: ['#000010', '#000020', '#000030'], alphas: [100, 150, 200], minWeight: 0.12, fullWeight: 0.6,
    });
    expect(px[3]).toBe(0); // too far from any station
    expect([px[4], px[5], px[6], px[7]]).toEqual([0, 0, 16, 100]); // 10 µg/m³: first band, full alpha
    expect([px[10], px[11]]).toEqual([48, 200]); // 40 µg/m³: top band
    expect(px[15]).toBeGreaterThan(0);
    expect(px[15]).toBeLessThan(200); // fading edge
  });
});
