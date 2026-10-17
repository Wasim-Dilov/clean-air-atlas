import { describe, expect, it } from 'vitest';
import { describeAge, minutesAgo, toGeoJSON, validateFrame, type StationFrame } from './stations';
import { darkenStyle } from './basemap';

const frame: StationFrame = {
  parameter: 'pm25', units: 'µg/m³', generated: '2026-10-17T14:00:00Z', source: 'OpenAQ', count: 3,
  id: [1, 2, 3], lon: [3.4, 7.5, -0.1], lat: [6.5, 9.1, 51.5], value: [80, 12, 30], age_min: [5, 20, 60],
};

describe('station frame', () => {
  it('accepts a well-formed frame', () => {
    expect(validateFrame(frame)).toBe(frame);
  });

  it('rejects empty or misaligned frames', () => {
    expect(() => validateFrame({ ...frame, count: 0 })).toThrow(/empty/);
    expect(() => validateFrame({ ...frame, lat: [1, 2] })).toThrow(/lat/);
    expect(() => validateFrame(null)).toThrow();
  });

  it('builds GeoJSON with band indexes, cleanest first', () => {
    const fc = toGeoJSON(frame);
    expect(fc.features.map((f) => f.id)).toEqual([2, 3, 1]);
    const lagos = fc.features.find((f) => f.id === 1)!;
    expect(lagos.geometry.coordinates).toEqual([3.4, 6.5]);
    expect(lagos.properties.b).toBe(5);
    expect(fc.features.find((f) => f.id === 2)!.properties.b).toBe(0);
  });

  it('describes reading age from the frame time', () => {
    const now = new Date('2026-10-17T14:30:00Z');
    expect(minutesAgo(frame.generated, 5, now)).toBe(35);
    expect(describeAge(0)).toBe('just now');
    expect(describeAge(35)).toBe('35 min ago');
    expect(describeAge(130)).toBe('2 hours ago');
  });
});

describe('dark base map', () => {
  it('recolours layers, hides POIs and drops 3D buildings', () => {
    const style = darkenStyle({
      version: 8,
      sources: {},
      layers: [
        { id: 'background', type: 'background', paint: { 'background-color': '#fff' } },
        { id: 'water', type: 'fill', source: 's', paint: { 'fill-color': '#9cf' } },
        { id: 'building-3d', type: 'fill-extrusion', source: 's' },
        { id: 'poi_r1', type: 'symbol', source: 's', layout: { 'icon-image': 'x' } },
        { id: 'label_country_1', type: 'symbol', source: 's', layout: { 'text-field': '{name}' } },
      ],
    } as never);
    const ids = style.layers.map((l) => l.id);
    expect(ids).not.toContain('building-3d');
    const byId = Object.fromEntries(style.layers.map((l) => [l.id, l as { paint?: Record<string, unknown>; layout?: Record<string, unknown> }]));
    expect(byId['background'].paint!['background-color']).toBe('#090d15');
    expect(byId['water'].paint!['fill-color']).toBe('#0c1422');
    expect(byId['poi_r1'].layout!.visibility).toBe('none');
    expect(byId['label_country_1'].paint!['text-halo-color']).toBe('#090d15');
    expect((style as { projection?: { type: string } }).projection).toEqual({ type: 'globe' });
  });
});
