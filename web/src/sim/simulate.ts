/** The simulator chain: displaced fossil MWh -> tonnes avoided -> damage avoided (EUR), as ranges. */

import { dispatch, type Battery, type DispatchResult } from './dispatch';
import {
  damageCosts, fuelFactor, gensetFactors, gridAverageFactors, POLLUTANTS, tonnes,
  type ByPollutant, type DamageBasis, type Pollutant, type Range,
} from './factors';
import { expandMonthlyDays, HOURS, solarMW, windowLoad } from './profiles';

export type Source =
  | { type: 'gensets'; count: number; kwEach: number; startHour: number; endHour: number }
  | { type: 'grid'; mw: number; startHour: number; endHour: number }
  | { type: 'plant'; fuel: 'Coal' | 'Gas' | 'Other fossil'; mw: number };

export interface PvProfile {
  hourly?: number[]; // 8760 W/kWp in local time
  monthly?: number[][]; // 12 x 24 W/kWp in approximate local solar time
}

export interface EmberCountry {
  name: string;
  years: Record<string, { twh: number[]; total_twh: number; intensity: number | null }>;
}

export interface Scenario {
  country: string; // ISO3
  source: Source;
  solarMWp: number;
  battery: Battery;
}

export interface Result {
  dispatch: DispatchResult;
  factors: ByPollutant; // kg/MWh
  tonnes: ByPollutant; // per year
  damage: { basis: DamageBasis; byPollutant: ByPollutant; total: Range; currency: string; priceYear: number };
  gridYear?: string;
  excludedShare: number;
  notes: string[];
}

export function latestYear(c: EmberCountry): string {
  return Object.keys(c.years).sort().at(-1)!;
}

export function pvYear(pv: PvProfile): Float64Array {
  if (pv.hourly && pv.hourly.length >= HOURS) return Float64Array.from(pv.hourly.slice(0, HOURS));
  if (pv.monthly) return expandMonthlyDays(pv.monthly);
  throw new Error('no solar profile');
}

export function loadFor(source: Source): Float64Array {
  switch (source.type) {
    case 'gensets':
      return windowLoad((source.count * source.kwEach) / 1000, source.startHour, source.endHour);
    case 'grid':
      return windowLoad(source.mw, source.startHour, source.endHour);
    case 'plant':
      return windowLoad(source.mw, 0, 24);
  }
}

const scale = (r: Range, k: number): Range => ({ low: r.low * k, central: r.central * k, high: r.high * k });
const add = (a: Range, b: Range): Range => ({ low: a.low + b.low, central: a.central + b.central, high: a.high + b.high });

export function simulate(s: Scenario, pv: PvProfile, ember: Record<string, EmberCountry>, fuels: string[]): Result {
  const notes: string[] = [];
  const d = dispatch(loadFor(s.source), solarMW(pvYear(pv), s.solarMWp), s.battery);

  let factors: ByPollutant;
  let excludedShare = 0;
  let gridYear: string | undefined;
  if (s.source.type === 'gensets') {
    factors = gensetFactors();
  } else if (s.source.type === 'plant') {
    factors = {} as ByPollutant;
    for (const p of POLLUTANTS) factors[p] = fuelFactor(s.source.fuel, p)!;
  } else {
    const c = ember[s.country];
    if (!c) throw new Error(`no Ember data for ${s.country}`);
    gridYear = latestYear(c);
    const g = gridAverageFactors(fuels, c.years[gridYear].twh);
    factors = g.factors;
    excludedShare = g.excludedShare;
    if (excludedShare > 0.01) notes.push(`Bioenergy (${(excludedShare * 100).toFixed(0)}% of generation) is not counted, so the gain is understated.`);
  }

  const t = {} as ByPollutant;
  for (const p of POLLUTANTS) t[p] = scale(factors[p], d.totals.displaced / 1000);

  const costs = damageCosts(s.country);
  const byPollutant = {} as ByPollutant;
  let total: Range = { low: 0, central: 0, high: 0 };
  for (const p of POLLUTANTS as Pollutant[]) {
    const c = costs.perTonne[p];
    byPollutant[p] = { low: t[p].low * c.low, central: t[p].central * c.central, high: t[p].high * c.high };
    total = add(total, byPollutant[p]);
  }
  if (costs.basis === 'transfer') notes.push('No official damage costs exist here: the euro range is a rough transfer from European values. Read the tonnes first.');
  if (costs.basis === 'eea') notes.push('Central damage uses the EEA lower (VOLY) valuation; the EEA publishes no central value.');
  return {
    dispatch: d, factors, tonnes: t,
    damage: { basis: costs.basis, byPollutant, total, currency: costs.currency, priceYear: costs.priceYear },
    gridYear, excludedShare, notes,
  };
}

export { tonnes };
