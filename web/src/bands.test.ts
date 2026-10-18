import { describe, expect, it } from 'vitest';
import who from '../../data/static/who_guidelines.json';
import { bandIndex, bands, needsRim, NO2_RAMP, PM25_EDGES, PM25_RAMP, POLLUTANTS, timesGuideline } from './bands';

/** OKLab lightness of a #rrggbb colour. */
function oklabL(hex: string): number {
  const lin = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
}

describe('WHO PM2.5 bands', () => {
  it('uses the WHO 2021 24-hour guideline and interim targets, ascending', () => {
    const day = who.pollutants.pm25['24h'];
    expect(PM25_EDGES).toEqual([day.guideline, day.interim_targets['IT-4'], day.interim_targets['IT-3'], day.interim_targets['IT-2'], day.interim_targets['IT-1']]);
    expect([...PM25_EDGES].sort((a, b) => a - b)).toEqual(PM25_EDGES);
  });

  it('puts a value equal to the guideline in the first band', () => {
    expect(bandIndex(PM25_EDGES[0])).toBe(0);
    expect(bandIndex(PM25_EDGES[0] + 0.01)).toBe(1);
    expect(bandIndex(0)).toBe(0);
    expect(bandIndex(10_000)).toBe(PM25_EDGES.length);
  });

  it('has one colour per band and readable labels', () => {
    const bs = bands();
    expect(bs).toHaveLength(PM25_RAMP.length);
    expect(bs[0].label).toBe(`≤${PM25_EDGES[0]}`);
    expect(bs.at(-1)!.label).toBe(`>${PM25_EDGES.at(-1)}`);
    expect(new Set(bs.map((b) => b.color)).size).toBe(bs.length);
  });

  it('expresses values as multiples of the guideline', () => {
    expect(timesGuideline(PM25_EDGES[0] * 3)).toBeCloseTo(3);
  });

  it('declares its source, year and units', () => {
    expect(who.source).toMatch(/WHO global air quality guidelines/);
    expect(who.year).toBe(2021);
    expect(who.units).toBe('µg/m³');
  });

  it('gets darker at every step, so the order reads without hue', () => {
    for (const ramp of [PM25_RAMP, NO2_RAMP]) {
      const L = ramp.map(oklabL);
      for (let i = 1; i < L.length; i++) expect(L[i - 1] - L[i]).toBeGreaterThanOrEqual(0.06);
    }
    expect(oklabL(PM25_RAMP[0])).toBeGreaterThan(0.85); // light green for the guideline band
    expect(oklabL(PM25_RAMP.at(-1)!)).toBeLessThan(0.25); // near-black for the worst
  });

  it('gives NO₂ the PM2.5 colours of matching WHO levels', () => {
    // NO₂ edges: guideline, IT-2, IT-1. Its second band spans PM2.5 bands 1 to 3 (takes the middle);
    // IT-2 to IT-1 and above IT-1 match PM2.5 bands 4 and 5.
    expect(NO2_RAMP).toEqual([PM25_RAMP[0], PM25_RAMP[2], PM25_RAMP[4], PM25_RAMP[5]]);
    expect(POLLUTANTS.no2.edges).toHaveLength(NO2_RAMP.length - 1);
  });

  it('outlines only the near-black top band', () => {
    expect(PM25_RAMP.map((_, i) => needsRim(i, PM25_RAMP))).toEqual([false, false, false, false, false, true]);
    expect(needsRim(3, NO2_RAMP)).toBe(true);
  });
});
