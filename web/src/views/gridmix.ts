/** Grid mix view: each country's electricity by source (Ember), on the map and in a panel. */

import type { Map as MapLibreMap, MapLayerMouseEvent, GeoJSONSource } from 'maplibre-gl';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import countries110 from 'world-atlas/countries-110m.json';
import iso from '../../../data/static/iso3166.json';

export interface EmberData {
  credit: string;
  fuels: string[];
  fossil: string[];
  years: number[];
  countries: Record<string, { name: string; years: Record<string, { twh: number[]; total_twh: number; intensity: number | null }> }>;
}

export type Metric = 'fossil' | 'windsolar';

// Validated six-step ordinal ramps on the #090d15 map surface (dataviz validator: all checks pass).
export const METRICS: Record<Metric, { label: string; legend: string; ramp: string[]; edges: number[] }> = {
  fossil: {
    label: 'Fossil share',
    legend: 'Share of electricity from coal, gas and other fossil fuels',
    ramp: ['#7d3501', '#a24702', '#ca5b04', '#f36f08', '#fe9a65', '#ffc6a9'],
    edges: [10, 30, 50, 70, 90],
  },
  windsolar: {
    label: 'Wind and solar share',
    legend: 'Share of electricity from wind and solar',
    ramp: ['#015c41', '#057957', '#01976d', '#08b785', '#00d79d', '#0af9b6'],
    edges: [2, 5, 10, 20, 35],
  },
};

// Group colours: first three categorical slots, validated all-pairs on the dark panel.
export const GROUPS = {
  fossil: { label: 'Fossil', color: '#d95926' },
  nuclear: { label: 'Nuclear', color: '#3987e5' },
  renewables: { label: 'Renewables', color: '#199e70' },
} as const;

export function groupOf(fuel: string, fossil: string[]): keyof typeof GROUPS {
  if (fossil.includes(fuel)) return 'fossil';
  if (fuel === 'Nuclear') return 'nuclear';
  return 'renewables';
}

export interface YearMix {
  year: string;
  total: number;
  intensity: number | null;
  shares: { fuel: string; twh: number; pct: number; group: keyof typeof GROUPS }[];
  groups: Record<keyof typeof GROUPS, number>; // percent
}

/** Mix for a country in a given year, or the closest earlier year with data. */
export function mixFor(data: EmberData, iso3: string, year: number): YearMix | null {
  const c = data.countries[iso3];
  if (!c) return null;
  const years = Object.keys(c.years).map(Number).filter((y) => y <= year).sort((a, b) => b - a);
  if (!years.length) return null;
  const y = String(years[0]);
  const row = c.years[y];
  const total = row.total_twh;
  const shares = data.fuels.map((fuel, i) => ({
    fuel, twh: row.twh[i], pct: total > 0 ? (row.twh[i] / total) * 100 : 0, group: groupOf(fuel, data.fossil),
  }));
  const groups = { fossil: 0, nuclear: 0, renewables: 0 };
  shares.forEach((s) => (groups[s.group] += s.pct));
  return { year: y, total, intensity: row.intensity, shares, groups };
}

export function metricValue(mix: YearMix, metric: Metric): number {
  if (metric === 'fossil') return mix.groups.fossil;
  return mix.shares.filter((s) => s.fuel === 'Wind' || s.fuel === 'Solar').reduce((a, s) => a + s.pct, 0);
}

export function binIndex(value: number, edges: number[]): number {
  let i = 0;
  while (i < edges.length && value > edges[i]) i++;
  return i;
}

const numericToAlpha3 = (iso as { numeric_to_alpha3: Record<string, string> }).numeric_to_alpha3;

/** Make ring longitudes continuous so shapes that cross the date line (Fiji, Russia) do not wrap the globe. */
export function unwrapRing(ring: number[][]): number[][] {
  const out: number[][] = [];
  for (const [x0, y] of ring) {
    let x = x0;
    if (out.length) {
      const px = out[out.length - 1][0];
      while (x - px > 180) x -= 360;
      while (x - px < -180) x += 360;
    }
    out.push([x, y]);
  }
  return out;
}

function unwrapGeometry(g: GeoJSON.Geometry): void {
  if (g.type === 'Polygon') g.coordinates = g.coordinates.map(unwrapRing);
  else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map((p) => p.map(unwrapRing));
}

/** Natural Earth 1:110m countries with ISO3 codes attached. */
export function countryShapes(): GeoJSON.FeatureCollection {
  const topo = countries110 as unknown as Topology<{ countries: GeometryCollection }>;
  const fc = feature(topo, topo.objects.countries) as GeoJSON.FeatureCollection;
  fc.features.forEach((f, i) => {
    if (f.geometry) unwrapGeometry(f.geometry);
    const iso3 = numericToAlpha3[String(f.id ?? '')] ?? '';
    f.properties = { ...(f.properties ?? {}), iso3 };
    f.id = i + 1;
  });
  return fc;
}

/** Id of the base map's first label layer, so data fills sit under place names. */
export function firstSymbolLayer(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
}

export class GridMixLayer {
  private shapes = countryShapes();
  private selected: number | null = null;
  metric: Metric = 'fossil';
  year: number;

  constructor(private map: MapLibreMap, private data: EmberData, private onSelect: (iso3: string | null) => void) {
    this.year = data.years.at(-1)!;
    map.addSource('countries', { type: 'geojson', data: this.shapes as never });
    const labels = firstSymbolLayer(map);
    map.addLayer({ id: 'grid-fill', type: 'fill', source: 'countries', layout: { visibility: 'none' }, paint: { 'fill-color': '#1a212d', 'fill-opacity': 0.92 } }, labels);
    map.addLayer({
      id: 'grid-line', type: 'line', source: 'countries', layout: { visibility: 'none' },
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#edf1f7', '#090d15'],
        'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2, 0.6],
      },
    }, labels);
    map.on('click', 'grid-fill', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const iso3 = (f?.properties as { iso3?: string })?.iso3;
      if (!f || !iso3 || !this.data.countries[iso3]) return;
      this.select(f.id as number);
      this.onSelect(iso3);
    });
    map.on('mouseenter', 'grid-fill', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'grid-fill', () => (map.getCanvas().style.cursor = ''));
    this.recolor();
  }

  select(id: number | null): void {
    if (this.selected !== null) this.map.setFeatureState({ source: 'countries', id: this.selected }, { selected: false });
    this.selected = id;
    if (id !== null) this.map.setFeatureState({ source: 'countries', id }, { selected: true });
  }

  selectIso(iso3: string): void {
    const f = this.shapes.features.find((x) => (x.properties as { iso3: string }).iso3 === iso3);
    this.select(f ? (f.id as number) : null);
  }

  setVisible(on: boolean): void {
    for (const id of ['grid-fill', 'grid-line']) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  recolor(): void {
    const m = METRICS[this.metric];
    const expr: unknown[] = ['match', ['get', 'iso3']];
    const seen = new Set<string>();
    for (const f of this.shapes.features) {
      const iso3 = (f.properties as { iso3: string }).iso3;
      if (!iso3 || seen.has(iso3)) continue;
      seen.add(iso3);
      const mix = mixFor(this.data, iso3, this.year);
      if (!mix) continue;
      expr.push(iso3, m.ramp[binIndex(metricValue(mix, this.metric), m.edges)]);
    }
    expr.push('#1a212d'); // no data
    this.map.setPaintProperty('grid-fill', 'fill-color', expr as never);
    void (this.map.getSource('countries') as GeoJSONSource | undefined);
  }
}
