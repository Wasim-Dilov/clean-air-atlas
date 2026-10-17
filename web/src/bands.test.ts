import { describe, expect, it } from 'vitest';
import who from '../../data/static/who_guidelines.json';
import { bandIndex, bands, PM25_EDGES, PM25_RAMP, timesGuideline } from './bands';

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
});
