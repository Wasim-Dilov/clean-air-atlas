import { describe, expect, it } from 'vitest';
import { buildSlots, defaultSlot, formatSlot, nearestModel, seriesShard, type ModelManifest, type StationManifest } from './timeline';
import { sparkPath } from './sparkline';
import { bandIndex, bands, NO2_RAMP, POLLUTANTS } from './bands';
import { unwrapRing } from './views/gridmix';

const stations: StationManifest = {
  parameter: 'pm25', units: 'µg/m³', latest: '2026-10-17T14:00:00Z', coords: 'c', series: 's/{shard}.json', shards: 16,
  frames: [
    { t: '2026-10-17T12:00:00Z', file: 'a', count: 1 },
    { t: '2026-10-17T14:00:00Z', file: 'b', count: 1 },
  ],
};
const model: ModelManifest = {
  parameter: 'pm25', bounds: [[-180, 85], [180, 85], [180, -85], [-180, -85]], latest_run: '2026-10-17T00:00:00Z',
  frames: [
    { valid: '2026-10-17T12:00:00Z', run: 'r', lead: 12, file: 'm12' },
    { valid: '2026-10-17T15:00:00Z', run: 'r', lead: 15, file: 'm15' },
    { valid: '2026-10-17T18:00:00Z', run: 'r', lead: 18, file: 'm18' },
  ],
};

describe('timeline', () => {
  it('builds hourly slots from measurements to the end of the forecast', () => {
    const slots = buildSlots(stations, model);
    expect(slots.map((s) => new Date(s.t).getUTCHours())).toEqual([12, 13, 14, 15, 16, 17, 18]);
    expect(slots.map((s) => s.measured)).toEqual([true, true, true, false, false, false, false]);
    expect(slots[0].stationFile).toBe('a');
    expect(slots[1].stationFile).toBeNull(); // missing hour stays a gap for stations
    expect(slots.map((s) => s.modelFile)).toEqual(['m12', 'm12', 'm15', 'm15', 'm15', 'm18', 'm18']);
    expect(defaultSlot(slots)).toBe(2);
  });

  it('works with only one source', () => {
    expect(buildSlots(stations, null)).toHaveLength(2);
    expect(buildSlots(null, model).every((s) => !s.measured)).toBe(true);
    expect(buildSlots(null, null)).toEqual([]);
  });

  it('only matches a model frame within 90 minutes', () => {
    expect(nearestModel(model.frames, Date.parse('2026-10-17T20:00:00Z'))).toBeNull();
    expect(nearestModel(model.frames, Date.parse('2026-10-17T19:00:00Z'))).toBe('m18');
  });

  it('formats slot times in UTC', () => {
    expect(formatSlot(Date.parse('2026-10-17T14:00:00Z'))).toBe('Sat 17 Oct, 14:00 UTC');
  });

  it('picks the series shard like the pipeline', () => {
    expect(seriesShard(35, 16)).toBe(3);
  });
});

describe('sparkline', () => {
  it('breaks the line at gaps and reports the last point', () => {
    const s = sparkPath([1, 2, null, 4], 100, 50);
    expect(s.d.match(/M/g)).toHaveLength(2);
    expect(s.count).toBe(3);
    expect(s.last!.x).toBeCloseTo(98);
  });

  it('keeps the guideline in view', () => {
    const s = sparkPath([1, 2], 100, 50, 15);
    expect(s.y(15)).toBeGreaterThan(0);
  });
});

describe('NO2 bands', () => {
  it('uses the WHO 24-hour NO2 guideline and interim targets', () => {
    expect(POLLUTANTS.no2.edges).toEqual([25, 50, 120]);
    expect(bands(POLLUTANTS.no2.edges, NO2_RAMP).map((b) => b.label)).toEqual(['≤25', '25–50', '50–120', '>120']);
    expect(bandIndex(25, POLLUTANTS.no2.edges)).toBe(0);
  });
});


describe('date line', () => {
  it('unwraps rings that cross 180°', () => {
    expect(unwrapRing([[179, -17], [-179, -17], [-179, -16], [179, -16]])).toEqual([[179, -17], [181, -17], [181, -16], [179, -16]]);
  });
});
