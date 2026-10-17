import type { StyleSpecification, LayerSpecification } from 'maplibre-gl';

/** Base map styles, tried in order. OpenFreeMap is donation-funded, so keep a fallback. */
export const BASE_STYLES = [
  'https://tiles.openfreemap.org/styles/liberty',
  'https://tiles.versatiles.org/assets/styles/colorful/style.json',
];

const C = {
  background: '#090d15',
  water: '#0c1422',
  land: '#0e141f',
  building: '#131a26',
  road: '#1a2230',
  roadMajor: '#222c3c',
  waterway: '#12203a',
  border: '#3a4558',
  label: '#8792a5',
  labelStrong: '#aab4c4',
  waterLabel: '#3f5a7d',
  halo: '#090d15',
};

const has = (id: string, ...words: string[]) => words.some((w) => id.includes(w));

/**
 * Recolour a light vector style into the app's dark, low-contrast base so the data
 * carries the colour. Only paint values change; sources and attribution stay as given.
 */
export function darkenStyle(style: StyleSpecification): StyleSpecification {
  const layers: LayerSpecification[] = [];
  for (const layer of style.layers) {
    const id = layer.id.toLowerCase();
    const l = structuredClone(layer) as LayerSpecification & { paint?: Record<string, unknown>; layout?: Record<string, unknown> };
    l.paint = l.paint ?? {};
    switch (l.type) {
      case 'background':
        l.paint = { 'background-color': C.background };
        break;
      case 'fill': {
        delete l.paint['fill-pattern'];
        delete l.paint['fill-outline-color'];
        if (has(id, 'water', 'ocean', 'sea', 'lake', 'river')) l.paint['fill-color'] = C.water;
        else if (has(id, 'building')) Object.assign(l.paint, { 'fill-color': C.building, 'fill-opacity': 0.6 });
        else Object.assign(l.paint, { 'fill-color': C.land, 'fill-opacity': 0.5 });
        break;
      }
      case 'fill-extrusion':
        continue; // no 3D buildings
      case 'line': {
        delete l.paint['line-pattern'];
        delete l.paint['line-gradient'];
        if (has(id, 'waterway', 'river', 'stream', 'canal')) l.paint['line-color'] = C.waterway;
        else if (has(id, 'boundary', 'admin', 'border')) Object.assign(l.paint, { 'line-color': C.border, 'line-opacity': 0.7 });
        else if (has(id, 'motorway', 'trunk', 'primary')) l.paint['line-color'] = C.roadMajor;
        else l.paint['line-color'] = C.road;
        break;
      }
      case 'symbol': {
        const layout = l.layout ?? {};
        const isPlace = has(id, 'place', 'country', 'state', 'city', 'town', 'capital', 'continent');
        const isWater = has(id, 'water', 'ocean', 'sea', 'lake', 'marine');
        if (!isPlace && !isWater) {
          l.layout = { ...layout, visibility: 'none' }; // POIs, road names, shields, housenumbers
          break;
        }
        delete layout['icon-image'];
        // One script per label: English name where the tiles have it.
        if (layout['text-field'] !== undefined) {
          layout['text-field'] = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
        }
        l.layout = layout;
        Object.assign(l.paint, {
          'text-color': isWater ? C.waterLabel : has(id, 'country', 'continent') ? C.labelStrong : C.label,
          'text-halo-color': C.halo,
          'text-halo-width': 1.2,
          'icon-opacity': 0,
        });
        break;
      }
      case 'hillshade':
        l.paint = { 'hillshade-shadow-color': '#000000', 'hillshade-highlight-color': C.road, 'hillshade-accent-color': C.land, 'hillshade-exaggeration': 0.2 };
        break;
      case 'raster':
        Object.assign(l.paint, { 'raster-saturation': -1, 'raster-brightness-max': 0.25 });
        break;
      default:
        break;
    }
    layers.push(l);
  }
  return { ...style, layers, projection: { type: 'globe' } } as StyleSpecification;
}

/** Fetch the first base style that loads and darken it. */
export async function loadBaseStyle(urls: string[] = BASE_STYLES, fetcher: typeof fetch = fetch): Promise<StyleSpecification> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      const style = (await res.json()) as StyleSpecification;
      if (!Array.isArray(style.layers)) throw new Error(`not a style: ${url}`);
      return darkenStyle(style);
    } catch (err) {
      lastError = err;
      console.warn('Base map style failed, trying the next one', err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('no base map style could be loaded');
}
