import who from '../../data/static/who_guidelines.json';

/**
 * One scale for every air layer: light green (meets the WHO guideline) through yellow, orange,
 * red and dark red to near-black (above the loosest interim target). Lightness falls at every
 * step, so the order still reads without telling green from red. Checked with the dataviz
 * palette validator on the #090d15 map surface, as swatches and as clouds blended at 92 %:
 * lightness monotone, every step at least 0.06 apart, all pairs at least ΔE 15 apart in normal
 * vision and ΔE 9.6 apart under simulated protanopia and deuteranopia.
 *
 * Near-black does not stand out from the dark map on its own, so it always carries a light
 * outline (RIM_COLOR): around its clouds, on its dots and on its legend swatch.
 */
export const PM25_RAMP = ['#9cf1b6', '#e9bd01', '#fe6e1a', '#cf2338', '#850122', '#2e0f13'] as const;
// NO₂ reuses PM2.5 colours by WHO level. Its edges are the guideline, IT-2 and IT-1, so its second
// band spans PM2.5 bands 1 to 3 and takes the middle one; the last two match PM2.5 bands 4 and 5.
export const NO2_RAMP = [PM25_RAMP[0], PM25_RAMP[2], PM25_RAMP[4], PM25_RAMP[5]] as const;
export const RIM_COLOR = '#aab4c4';

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

/** The top band is near-black and needs the light outline to show on the dark map. */
export function needsRim(band: number, ramp: readonly string[]): boolean {
  return band === ramp.length - 1;
}

/** How many times the WHO 24-hour guideline a value is (indicative for hourly values). */
export function timesGuideline(value: number, guideline: number = PM25_GUIDELINE): number {
  return value / guideline;
}
