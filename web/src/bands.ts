import who from '../../data/static/who_guidelines.json';

/**
 * Ordinal ramps (one hue, lightness rising with concentration) for a dark map.
 * Checked with the dataviz palette validator against the #090d15 map surface:
 * monotone lightness, visible step gaps, darkest step above 2:1 contrast.
 */
export const PM25_RAMP = ['#a83902', '#d24903', '#f5642b', '#ff936d', '#ffc0ab', '#fee5dc'] as const;
export const NO2_RAMP = ['#a83902', '#f5642b', '#ffc0ab', '#fee5dc'] as const;

export type Pollutant = 'pm25' | 'no2';

export interface Band {
  index: number;
  min: number | null; // exclusive lower edge (null for the first band)
  max: number | null; // inclusive upper edge (null for the last band)
  color: string;
  label: string;
}

export interface PollutantSpec {
  id: Pollutant;
  label: string;
  guideline: number;
  /** WHO 2021 24-hour levels, ascending: guideline, then interim targets from strictest to loosest. */
  edges: readonly number[];
  ramp: readonly string[];
}

function whoEdges(p: Pollutant): number[] {
  const day = who.pollutants[p]['24h'];
  const its = Object.values(day.interim_targets as Record<string, number>).sort((a, b) => a - b);
  return [day.guideline, ...its];
}

export const POLLUTANTS: Record<Pollutant, PollutantSpec> = {
  pm25: { id: 'pm25', label: 'PM2.5', guideline: who.pollutants.pm25['24h'].guideline, edges: whoEdges('pm25'), ramp: PM25_RAMP },
  no2: { id: 'no2', label: 'NO₂', guideline: who.pollutants.no2['24h'].guideline, edges: whoEdges('no2'), ramp: NO2_RAMP },
};

export const PM25_EDGES: readonly number[] = POLLUTANTS.pm25.edges;
export const PM25_GUIDELINE = POLLUTANTS.pm25.guideline;

/** Band index for a value: a value equal to an edge belongs to the lower band (≤ guideline meets it). */
export function bandIndex(value: number, edges: readonly number[] = PM25_EDGES): number {
  let i = 0;
  while (i < edges.length && value > edges[i]) i++;
  return i;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function bands(edges: readonly number[] = PM25_EDGES, ramp: readonly string[] = PM25_RAMP): Band[] {
  if (ramp.length !== edges.length + 1) throw new Error('ramp needs one more colour than edges');
  return ramp.map((color, i) => {
    const min = i === 0 ? null : edges[i - 1];
    const max = i === edges.length ? null : edges[i];
    const label = min === null ? `≤${fmt(max!)}` : max === null ? `>${fmt(min)}` : `${fmt(min)}–${fmt(max)}`;
    return { index: i, min, max, color, label };
  });
}

/** How many times the WHO 24-hour guideline a value is (indicative for hourly values). */
export function timesGuideline(value: number, guideline: number = PM25_GUIDELINE): number {
  return value / guideline;
}
