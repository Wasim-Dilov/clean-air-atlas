import who from '../../data/static/who_guidelines.json';

/**
 * Six-step ordinal ramp (one hue, lightness rising with concentration) for a dark map.
 * Checked with the dataviz palette validator against the #090d15 map surface:
 * monotone lightness, visible step gaps, darkest step above 2:1 contrast.
 */
export const PM25_RAMP = ['#a83902', '#d24903', '#f5642b', '#ff936d', '#ffc0ab', '#fee5dc'] as const;

export interface Band {
  index: number;
  min: number | null; // exclusive lower edge (null for the first band)
  max: number | null; // inclusive upper edge (null for the last band)
  color: string;
  label: string;
}

const pm25Day = who.pollutants.pm25['24h'];

/** WHO 2021 24-hour PM2.5 levels, ascending: guideline, IT-4, IT-3, IT-2, IT-1. */
export const PM25_EDGES: readonly number[] = [
  pm25Day.guideline,
  pm25Day.interim_targets['IT-4'],
  pm25Day.interim_targets['IT-3'],
  pm25Day.interim_targets['IT-2'],
  pm25Day.interim_targets['IT-1'],
];

export const PM25_GUIDELINE = pm25Day.guideline;

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
