/**
 * Golden test for the Lagos preset, so its numbers cannot drift unnoticed.
 * If an input in data/static/ changes on purpose, update these values in the same commit
 * and say why in the commit message.
 */
import { describe, expect, it } from 'vitest';
import presets from '../../../data/static/presets.json';
import pv from '../../../data/static/pv_profiles.json';
import ember from '../../../data/static/ember_electricity.json';
import { simulate, type EmberCountry } from './simulate';

const GOLDEN = {
  load: 24637.5,
  solar: 13580.77,
  displaced: 13151.229855658337,
  cycles: 164.14720020026104,
  tonnes: {
    NOx: [247.88753154930401, 247.98746790978063, 347.04254416902563],
    SO2: [9.420225945608069, 16.399171265001627, 16.399171265001627],
    'PM2.5': [17.592400177914158, 17.599110625855403, 24.629623273676934],
  },
  damageEur: [5480104.666294458, 5595362.037397303, 21375594.78137274],
};

describe('Lagos diesel generator preset', () => {
  const p = presets.presets.lagos;
  const r = simulate(
    {
      country: p.country,
      source: { type: 'gensets', count: p.source.count, kwEach: p.source.kw_each, startHour: p.source.start_hour, endHour: p.source.end_hour },
      solarMWp: p.solar_mwp,
      battery: {
        powerMW: p.battery.power_mw, energyMWh: p.battery.energy_mwh,
        roundTrip: presets.battery_defaults.round_trip, usableDoD: presets.battery_defaults.usable_dod,
      },
    },
    { hourly: pv.sites.lagos.hourly_w_per_kwp },
    ember.countries as unknown as Record<string, EmberCountry>,
    ember.fuels,
  );
  const close = (a: number, b: number) => expect(Math.abs(a - b) / Math.max(Math.abs(b), 1e-9)).toBeLessThan(1e-6);

  it('serves the same load with the same solar', () => {
    close(r.dispatch.totals.load, GOLDEN.load);
    close(r.dispatch.totals.solar, GOLDEN.solar);
    close(r.dispatch.totals.displaced, GOLDEN.displaced);
    close(r.dispatch.totals.cycles, GOLDEN.cycles);
  });

  it('avoids the same tonnes and damage, as ranges', () => {
    for (const [p2, [lo, c, hi]] of Object.entries(GOLDEN.tonnes)) {
      const t = r.tonnes[p2 as keyof typeof r.tonnes];
      close(t.low, lo);
      close(t.central, c);
      close(t.high, hi);
    }
    close(r.damage.total.low, GOLDEN.damageEur[0]);
    close(r.damage.total.central, GOLDEN.damageEur[1]);
    close(r.damage.total.high, GOLDEN.damageEur[2]);
    expect(r.damage.basis).toBe('transfer');
    expect(r.notes.join(' ')).toMatch(/rough transfer/);
  });
});
