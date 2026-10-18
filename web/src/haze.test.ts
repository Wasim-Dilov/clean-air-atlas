import { describe, expect, it } from 'vitest';
import { blendSums, colorizeHaze, mercatorLonLat, mercatorXY, splat, topBandField } from './haze';

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

  it('inverts the Web Mercator pixel position', () => {
    for (const [lon, lat] of [[0, 0], [16.4, 48.2], [-120, -33], [179, 70]]) {
      const [x, y] = mercatorXY(lon, lat, 2048);
      const [lo, la] = mercatorLonLat(x, y, 2048);
      expect(lo).toBeCloseTo(lon, 6);
      expect(la).toBeCloseTo(lat, 6);
    }
  });

  it('reuses buffers and lets the wide kernel fill only where the narrow one is thin', () => {
    const size = 64;
    const pts = [{ lon: 0, lat: 0, v: 10 }];
    const near = splat(pts, size, 1, { num: new Float32Array(size * size).fill(9), den: new Float32Array(size * size).fill(9) });
    const wide = splat(pts, size, 4);
    const at = (x: number) => 32 * size + x;
    expect(near.den[at(32)]).toBeCloseTo(1); // old buffer contents cleared
    expect(near.den[at(32 + 6)]).toBe(0); // beyond the narrow kernel
    blendSums(near, wide, 0.05);
    expect(near.num[at(32)] / near.den[at(32)]).toBeCloseTo(10);
    expect(near.den[at(32)]).toBeCloseTo(1.05);
    expect(near.num[at(32 + 6)] / near.den[at(32 + 6)]).toBeCloseTo(10); // filled by the wide kernel
  });

  it('takes coverage from its own weights when given', () => {
    const num = new Float32Array([10, 10]);
    const den = new Float32Array([1, 1]);
    const cover = new Float32Array([0.05, 1]);
    const px = colorizeHaze(num, den, { edges: [15], ramp: ['#000010', '#000020'], alphas: [200, 200], minWeight: 0.1, fullWeight: 0.5 }, undefined, cover);
    expect(px[3]).toBe(0);
    expect(px[7]).toBe(200);
  });

  it('blends band colours across an edge, half and half on the edge itself', () => {
    const style = { edges: [10], ramp: ['#000000', '#c80000'], alphas: [200, 200], minWeight: 0, fullWeight: 0.001, soft: 1 };
    const red = (v: number) => colorizeHaze(new Float32Array([v]), new Float32Array([1]), style)[0];
    expect(red(8)).toBe(0); // further than `soft` below the edge: pure lower band
    expect(red(10)).toBe(100); // on the edge
    expect(red(10.0001)).toBe(100); // just above: continuous
    expect(red(9.5)).toBe(50);
    expect(red(12)).toBe(200); // pure upper band
    expect(colorizeHaze(new Float32Array([10]), new Float32Array([1]), { ...style, soft: 0 })[0]).toBe(0); // hard edges by default
  });

  it('outlines the top band only where its cloud is drawn', () => {
    const num = new Float32Array([100, 100, 50, 0]);
    const den = new Float32Array([1, 1, 1, 0]);
    const cover = new Float32Array([1, 0.1, 1, 0]);
    const f = topBandField(num, den, 75, 0.2, undefined, cover);
    expect(f[0]).toBeGreaterThan(0); // above the edge, well covered
    expect(f[1]).toBeLessThan(0); // above the edge, but the cloud is faded out here
    expect(f[2]).toBeLessThan(0); // below the edge
    expect(f[3]).toBe(-1); // no stations
  });
});
