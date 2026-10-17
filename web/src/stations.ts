import { bandIndex, PM25_EDGES } from './bands';

/** Columnar frame written by pipeline/openaq.py (one entry per station). */
export interface StationFrame {
  parameter: string;
  units: string;
  generated: string;
  source: string;
  count: number;
  id: number[];
  lon: number[];
  lat: number[];
  value: number[];
  age_min: number[];
}

/** Lazy-loaded station names and data credits, keyed by OpenAQ location id. */
export interface StationIndex {
  generated: string;
  fields: string[];
  stations: Record<string, [name: string, locality: string, country: string, provider: string]>;
  providers: { name: string; stations: number }[];
  attributions: { name: string; url: string | null }[];
}

export interface StationProps {
  id: number;
  v: number;
  b: number;
  age: number;
}

export interface PointFeature {
  type: 'Feature';
  id: number;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: StationProps;
}

export interface PointCollection {
  type: 'FeatureCollection';
  features: PointFeature[];
}

const COLUMNS = ['id', 'lon', 'lat', 'value', 'age_min'] as const;

export function validateFrame(raw: unknown): StationFrame {
  if (typeof raw !== 'object' || raw === null) throw new Error('station frame is not an object');
  const f = raw as Partial<StationFrame>;
  if (typeof f.count !== 'number' || f.count < 1) throw new Error('station frame is empty');
  for (const col of COLUMNS) {
    const arr = f[col];
    if (!Array.isArray(arr) || arr.length !== f.count) throw new Error(`column ${col} does not match count`);
  }
  if (typeof f.generated !== 'string') throw new Error('station frame has no timestamp');
  return f as StationFrame;
}

export function toGeoJSON(frame: StationFrame, edges: readonly number[] = PM25_EDGES): PointCollection {
  const features: PointFeature[] = new Array(frame.count);
  for (let i = 0; i < frame.count; i++) {
    const v = frame.value[i];
    features[i] = {
      type: 'Feature',
      id: frame.id[i],
      geometry: { type: 'Point', coordinates: [frame.lon[i], frame.lat[i]] },
      properties: { id: frame.id[i], v, b: bandIndex(v, edges), age: frame.age_min[i] },
    };
  }
  // Draw cleaner stations first so the most polluted sit on top.
  features.sort((a, b) => a.properties.v - b.properties.v);
  return { type: 'FeatureCollection', features };
}

/** One hour of the rolling history: ids and values, with positions in a shared coords file. */
export interface HistoryFrame {
  t: string;
  id: number[];
  v: number[];
}

export interface Coords {
  id: number[];
  lon: number[];
  lat: number[];
}

export function historyToGeoJSON(h: HistoryFrame, coords: Coords, edges: readonly number[]): PointCollection {
  const pos = new Map<number, [number, number]>();
  coords.id.forEach((id, i) => pos.set(id, [coords.lon[i], coords.lat[i]]));
  const features: PointFeature[] = [];
  h.id.forEach((id, i) => {
    const p = pos.get(id);
    if (!p) return;
    const v = h.v[i];
    features.push({ type: 'Feature', id, geometry: { type: 'Point', coordinates: p }, properties: { id, v, b: bandIndex(v, edges), age: -1 } });
  });
  features.sort((a, b) => a.properties.v - b.properties.v);
  return { type: 'FeatureCollection', features };
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} loading ${url}`);
  return (await res.json()) as T;
}

export function minutesAgo(generated: string, ageMin: number, now: Date = new Date()): number {
  const gen = Date.parse(generated);
  const extra = Number.isFinite(gen) ? Math.max(0, Math.round((now.getTime() - gen) / 60000)) : 0;
  return ageMin + extra;
}

export function describeAge(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const h = Math.floor(minutes / 60);
  return h === 1 ? '1 hour ago' : `${h} hours ago`;
}
