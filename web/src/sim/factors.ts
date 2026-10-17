/**
 * Emission factors (kg per MWh of electricity, which equals g per kWh) and damage costs
 * (EUR per tonne), each as a low / central / high range, read from data/static/.
 */

import factorsJson from '../../../data/static/emission_factors.json';
import damageJson from '../../../data/static/damage_costs.json';
import fxJson from '../../../data/static/fx.json';

export type Pollutant = 'NOx' | 'SO2' | 'PM2.5';
export const POLLUTANTS: Pollutant[] = ['NOx', 'SO2', 'PM2.5'];

export interface Range {
  low: number;
  central: number;
  high: number;
}

export type ByPollutant = Record<Pollutant, Range>;

interface PowerRow { fuel: string; pollutant: string; value: number; low: number | null; high: number | null; unit: string }
interface GensetRow { class: string; pollutant: string; value: number; unit: string }
interface EffRow { fuel: string; central: number; low: number; high: number }
interface DamageRow { iso3: string; pollutant: string; low: number | null; central: number | null; high: number | null; currency: string; price_year: number; source: string }

export const factorsData = factorsJson as unknown as {
  constants: Record<string, { value: number }>;
  power_plants: PowerRow[];
  gensets: GensetRow[];
  plant_efficiency: EffRow[];
  ember_fuel_mapping: Record<string, { factors?: string; envelope_with?: string; efficiency?: string; excluded?: boolean; note: string }>;
};
export const damageData = damageJson as unknown as { rows: DamageRow[]; sources: Record<string, { title: string; url: string }> };
export const fx = fxJson as { gbp_per_eur: number; date: string };

const C = factorsData.constants;

// ---------------------------------------------------------------- unit conversions

/** lb per horsepower-hour of output to g per kWh of output (= kg/MWh). */
export function lbPerHpHrToGPerKWh(v: number): number {
  return (v * C.g_per_lb.value) / C.kwh_per_hp_hr.value;
}

/** g per GJ of fuel (net calorific value) to kg per MWh of electricity, at a given efficiency. */
export function gPerGJToKgPerMWh(gPerGJ: number, efficiency: number): number {
  return (gPerGJ * C.gj_per_mwh.value) / efficiency / 1000;
}

export function gbpToEur(gbp: number, gbpPerEur: number = fx.gbp_per_eur): number {
  return gbp / gbpPerEur;
}

/** Tonnes from MWh and kg/MWh. */
export function tonnes(mwh: number, kgPerMWh: number): number {
  return (mwh * kgPerMWh) / 1000;
}

// ---------------------------------------------------------------- power plant factors by Ember fuel

function powerRow(fuel: string, pollutant: Pollutant): PowerRow {
  const row = factorsData.power_plants.find((r) => r.fuel === fuel && r.pollutant === pollutant);
  if (!row) throw new Error(`no ${pollutant} factor for ${fuel}`);
  return row;
}

/** kg/MWh range for one Ember fuel, or null when the fuel is not counted. */
export function fuelFactor(emberFuel: string, pollutant: Pollutant): Range | null {
  const map = factorsData.ember_fuel_mapping[emberFuel];
  if (!map || map.excluded || !map.factors || !map.efficiency) return null;
  const eff = factorsData.plant_efficiency.find((e) => e.fuel === map.efficiency);
  if (!eff) throw new Error(`no efficiency for ${map.efficiency}`);
  const main = powerRow(map.factors, pollutant);
  const rows = [main, ...(map.envelope_with ? [powerRow(map.envelope_with, pollutant)] : [])];
  const lows = rows.map((r) => r.low ?? r.value);
  const highs = rows.map((r) => r.high ?? r.value);
  return {
    low: gPerGJToKgPerMWh(Math.min(...lows), eff.high),
    central: gPerGJToKgPerMWh(main.value, eff.central),
    high: gPerGJToKgPerMWh(Math.max(...highs), eff.low),
  };
}

/** Grid-average kg/MWh: generation-weighted over all sources (zero for non-combustion). */
export function gridAverageFactors(fuels: string[], twh: number[]): { factors: ByPollutant; excludedShare: number } {
  const total = twh.reduce((s, v) => s + v, 0);
  const factors = {} as ByPollutant;
  let excluded = 0;
  fuels.forEach((f, i) => {
    if (factorsData.ember_fuel_mapping[f]?.excluded) excluded += twh[i];
  });
  for (const p of POLLUTANTS) {
    const r: Range = { low: 0, central: 0, high: 0 };
    fuels.forEach((f, i) => {
      const share = total > 0 ? twh[i] / total : 0;
      const ef = fuelFactor(f, p);
      if (!ef || share === 0) return;
      r.low += share * ef.low;
      r.central += share * ef.central;
      r.high += share * ef.high;
    });
    factors[p] = r;
  }
  return { factors, excludedShare: total > 0 ? excluded / total : 0 };
}

/** Small diesel generators: AP-42 3.3 central, range across AP-42 and World Bank Nigeria factors. */
export function gensetFactors(): ByPollutant {
  const out = {} as ByPollutant;
  for (const p of POLLUTANTS) {
    const rows = factorsData.gensets.filter((r) => r.pollutant === p);
    const toKgMWh = (r: GensetRow) => (r.unit.startsWith('lb/hp-hr') ? lbPerHpHrToGPerKWh(r.value) : r.value);
    const ap42 = rows.find((r) => r.class === 'ap42_3_3');
    if (!ap42) throw new Error(`no AP-42 factor for ${p}`);
    const all = rows.map(toKgMWh);
    out[p] = { low: Math.min(...all), central: toKgMWh(ap42), high: Math.max(...all) };
  }
  return out;
}

// ---------------------------------------------------------------- damage costs

export type DamageBasis = 'eea' | 'defra' | 'transfer';

export interface DamageCosts {
  basis: DamageBasis;
  perTonne: ByPollutant; // EUR per tonne
  currency: string; // original currency
  priceYear: number;
}

/** EUR per tonne for a country: Defra for the UK, EEA for European countries, else a rough transfer. */
export function damageCosts(iso3: string): DamageCosts {
  const rows = damageData.rows;
  const pick = (pred: (r: DamageRow) => boolean, convert: (v: number) => number, centralFromLow: boolean) => {
    const out = {} as ByPollutant;
    for (const p of POLLUTANTS) {
      const r = rows.find((x) => pred(x) && x.pollutant === p);
      if (!r || r.low === null || r.high === null) return null;
      const central = r.central ?? (centralFromLow ? r.low : null);
      if (central === null) return null;
      out[p] = { low: convert(r.low), central: convert(central), high: convert(r.high) };
    }
    return out;
  };
  if (iso3 === 'GBR') {
    const v = pick((r) => r.iso3 === 'GBR' && r.currency === 'GBP', (x) => gbpToEur(x), false);
    if (v) return { basis: 'defra', perTonne: v, currency: 'GBP', priceYear: 2025 };
  }
  const eea = pick((r) => r.iso3 === iso3 && r.source === 'eea2024', (x) => x, true);
  if (eea) return { basis: 'eea', perTonne: eea, currency: 'EUR', priceYear: 2021 };
  const avg = pick((r) => r.iso3 === 'EEA_AVG', (x) => x, true);
  if (!avg) throw new Error('EEA average damage costs missing');
  return { basis: 'transfer', perTonne: avg, currency: 'EUR', priceYear: 2021 };
}
