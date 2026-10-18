import { describe, expect, it } from 'vitest';
import damage from '../../../data/static/damage_costs.json';
import factorsJson from '../../../data/static/emission_factors.json';
import fx from '../../../data/static/fx.json';
import ember from '../../../data/static/ember_electricity.json';
import { dispatch } from './dispatch';
import {
  damageCosts, factorsData, fuelFactor, gbpToEur, gensetFactors, gPerGJToKgPerMWh, gridAverageFactors, lbPerHpHrToGPerKWh, tonnes,
} from './factors';
import { expandMonthlyDays, HOURS, solarMW, windowLoad } from './profiles';

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

describe('dispatch', () => {
  const r = rng(42);
  const load = Array.from({ length: HOURS }, () => 2 + r() * 4);
  const solar = Array.from({ length: HOURS }, (_, h) => Math.max(0, Math.sin(((h % 24) - 6) / 12 * Math.PI)) * 9 * (0.4 + r() * 0.6));
  const battery = { powerMW: 3, energyMWh: 12, roundTrip: 0.85, usableDoD: 0.9 };
  const d = dispatch(load, solar, battery);

  it('closes the hourly energy balance within 0.1%', () => {
    for (let h = 0; h < HOURS; h++) {
      const served = d.solarToLoad[h] + d.discharge[h] + d.fossil[h];
      expect(Math.abs(served - load[h])).toBeLessThanOrEqual(0.001 * load[h] + 1e-9);
      const used = d.solarToLoad[h] + d.charge[h] + d.curtailed[h];
      expect(Math.abs(used - solar[h])).toBeLessThanOrEqual(0.001 * solar[h] + 1e-9);
    }
    const t = d.totals;
    expect(Math.abs(t.solarToLoad + t.discharge + t.fossil - t.load) / t.load).toBeLessThan(0.001);
  });

  it('keeps state of charge inside the usable window and respects power limits', () => {
    const eps = 1e-9;
    let prev = d.soc[HOURS - 1];
    for (let h = 0; h < HOURS; h++) {
      expect(d.soc[h]).toBeGreaterThanOrEqual(d.socMin - eps);
      expect(d.soc[h]).toBeLessThanOrEqual(d.socMax + eps);
      expect(d.charge[h]).toBeLessThanOrEqual(battery.powerMW + eps);
      expect(d.discharge[h]).toBeLessThanOrEqual(battery.powerMW + eps);
      const eta = Math.sqrt(battery.roundTrip);
      expect(d.soc[h]).toBeCloseTo(prev + d.charge[h] * eta - d.discharge[h] / eta, 6);
      prev = d.soc[h];
    }
    expect(d.socMin).toBeCloseTo(12 * 0.1);
  });

  it('never charges from fossil generation', () => {
    for (let h = 0; h < HOURS; h++) {
      expect(d.charge[h]).toBeLessThanOrEqual(Math.max(solar[h] - d.solarToLoad[h], 0) + 1e-9);
      if (d.charge[h] > 1e-9) expect(d.fossil[h]).toBeLessThan(1e-9);
    }
  });

  it('displaces nothing extra without a battery', () => {
    const nb = dispatch(load, solar, { ...battery, powerMW: 0 });
    expect(nb.totals.discharge).toBe(0);
    expect(nb.totals.displaced).toBeLessThan(d.totals.displaced);
  });
});

describe('profiles', () => {
  it('expands 12 typical days to a 365-day year', () => {
    const y = expandMonthlyDays(Array.from({ length: 12 }, (_, m) => Array(24).fill(m)));
    expect(y.length).toBe(HOURS);
    expect(y[0]).toBe(0);
    expect(y[HOURS - 1]).toBe(11);
    expect(y[31 * 24]).toBe(1);
  });

  it('scales W per kWp to MW and builds daily windows', () => {
    expect(solarMW([500], 10)[0]).toBe(5);
    const w = windowLoad(2, 6, 24);
    expect(w[5]).toBe(0);
    expect(w[6]).toBe(2);
    expect(w[23]).toBe(2);
    expect(windowLoad(1, 22, 2)[23]).toBe(1);
  });
});

describe('conversions', () => {
  it('converts lb/hp-hr to g/kWh', () => {
    expect(lbPerHpHrToGPerKWh(1)).toBeCloseTo(608.2774, 3);
  });

  it('converts g/GJ of fuel to kg/MWh of electricity', () => {
    expect(gPerGJToKgPerMWh(100, 0.4)).toBeCloseTo(0.9);
  });

  it('converts MWh and kg/MWh to tonnes', () => {
    expect(tonnes(1000, 2.5)).toBeCloseTo(2.5);
  });

  it('converts GBP to EUR with the dated ECB rate', () => {
    expect(fx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(gbpToEur(fx.gbp_per_eur * 100)).toBeCloseTo(100);
  });
});

describe('static inputs are sourced', () => {
  it('every damage cost row declares its currency, price year and source', () => {
    for (const r of damage.rows) {
      expect(['EUR', 'GBP']).toContain(r.currency);
      expect(r.price_year).toBeGreaterThan(2000);
      expect(Object.keys(damage.sources)).toContain(r.source);
      expect(r.table).toBeTruthy();
    }
  });

  it('every emission factor row has units, a source and a table', () => {
    for (const r of [...factorsJson.power_plants, ...factorsJson.gensets]) {
      expect(r.unit).toBeTruthy();
      expect(Object.keys(factorsJson.sources)).toContain(r.source);
      expect(r.table).toBeTruthy();
      expect(r.value).toBeGreaterThan(0);
    }
    for (const e of factorsJson.plant_efficiency) {
      expect(e.low).toBeLessThanOrEqual(e.central);
      expect(e.central).toBeLessThanOrEqual(e.high);
      expect(e.high).toBeLessThan(1);
    }
  });
});

describe('factors and damage costs', () => {
  it('orders every range low <= central <= high', () => {
    const check = (r: { low: number; central: number; high: number }) => {
      expect(r.low).toBeLessThanOrEqual(r.central);
      expect(r.central).toBeLessThanOrEqual(r.high);
    };
    for (const f of ['Coal', 'Gas', 'Other fossil']) for (const p of ['NOx', 'SO2', 'PM2.5'] as const) check(fuelFactor(f, p)!);
    Object.values(gensetFactors()).forEach(check);
    for (const iso of ['DEU', 'GBR', 'NGA', 'POL']) Object.values(damageCosts(iso).perTonne).forEach(check);
  });

  it('weights grid factors by generation and skips non-combustion sources', () => {
    const fuels = factorsData.ember_fuel_mapping ? (ember.fuels as string[]) : [];
    const onlyGas = fuels.map((f) => (f === 'Gas' ? 1 : 0));
    const halfGas = fuels.map((f) => (f === 'Gas' || f === 'Solar' ? 1 : 0));
    const a = gridAverageFactors(fuels, onlyGas).factors.NOx.central;
    const b = gridAverageFactors(fuels, halfGas).factors.NOx.central;
    expect(b).toBeCloseTo(a / 2);
    expect(fuelFactor('Bioenergy', 'NOx')).toBeNull();
  });

  it('picks Defra for the UK, EEA in Europe and a labelled transfer elsewhere', () => {
    expect(damageCosts('GBR').basis).toBe('defra');
    expect(damageCosts('DEU').basis).toBe('eea');
    expect(damageCosts('NGA').basis).toBe('transfer');
  });
});
