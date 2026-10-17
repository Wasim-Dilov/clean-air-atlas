import { Map as MapLibreMap, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent } from 'maplibre-gl';
// Let Vite bundle MapLibre's worker so its URL survives pre-bundling and the build.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

import { bands, PM25_RAMP, timesGuideline } from './bands';
import { loadBaseStyle } from './basemap';
import {
  describeAge, fetchJson, minutesAgo, toGeoJSON, validateFrame,
  type StationFrame, type StationIndex, type StationProps,
} from './stations';

const DATA = {
  frame: 'data/stations-pm25.json',
  index: 'data/stations-pm25-index.json',
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function renderLegend(): void {
  const ramp = $('legend-ramp');
  const labels = $('legend-labels');
  for (const b of bands()) {
    const sw = document.createElement('span');
    sw.style.background = b.color;
    sw.title = `${b.label} µg/m³`;
    ramp.append(sw);
    const lab = document.createElement('span');
    lab.textContent = b.label;
    labels.append(lab);
  }
}

function showNotice(text: string): void {
  const el = $('notice');
  el.textContent = text;
  el.hidden = false;
}

function setStatus(frame: StationFrame): void {
  const when = new Date(frame.generated);
  const time = when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  $('status').textContent = `Updated ${time} UTC`;
  $('station-count').textContent = `${frame.count.toLocaleString()} stations reporting in the last 6 hours.`;
}

function setupLegendToggle(): void {
  const btn = $<HTMLButtonElement>('legend-toggle');
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    $('controls').classList.toggle('open', open);
  });
}

function setupSourcesDialog(getIndex: () => StationIndex | null): void {
  const dialog = $<HTMLDialogElement>('sources');
  $('open-sources').addEventListener('click', () => {
    const index = getIndex();
    const providers = $('providers');
    const atts = $('attributions');
    providers.replaceChildren();
    atts.replaceChildren();
    if (!index) {
      providers.textContent = 'Provider list is still loading.';
    } else {
      for (const p of index.providers) {
        const li = document.createElement('li');
        li.textContent = `${p.name} (${p.stations.toLocaleString()} stations)`;
        providers.append(li);
      }
      for (const a of index.attributions) {
        const li = document.createElement('li');
        if (a.url) {
          const link = document.createElement('a');
          link.href = a.url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = a.name;
          li.append(link);
        } else {
          li.textContent = a.name;
        }
        atts.append(li);
      }
    }
    dialog.showModal();
  });
  $('sources-close').addEventListener('click', () => dialog.close());
}

async function main(): Promise<void> {
  // In dev, MapLibre finds its own worker next to its module (see optimizeDeps in vite.config).
  if (import.meta.env.PROD) setWorkerUrl(workerUrl);
  renderLegend();
  setupLegendToggle();

  let index: StationIndex | null = null;
  let frame: StationFrame | null = null;
  setupSourcesDialog(() => index);

  const style = await loadBaseStyle().catch((err) => {
    console.error(err);
    showNotice('The base map could not load. Station data is still shown.');
    return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#090d15' } }] } as const;
  });

  const map = new MapLibreMap({
    container: 'map',
    style: style as never,
    center: [10, 22],
    zoom: window.innerWidth < 760 ? 1.8 : 2.1,
    minZoom: 0.5,
    maxZoom: 14,
    attributionControl: { compact: true },
  });
  $('zoom-in').addEventListener('click', () => map.zoomIn());
  $('zoom-out').addEventListener('click', () => map.zoomOut());

  const framePromise = fetchJson<unknown>(DATA.frame).then(validateFrame);
  fetchJson<StationIndex>(DATA.index).then((i) => (index = i)).catch((err) => console.warn('station index', err));

  map.once('style.load', async () => {
    try {
      frame = await framePromise;
    } catch (err) {
      console.error(err);
      $('status').textContent = 'No station data';
      showNotice('Station data is not available right now. It refreshes every hour.');
      return;
    }
    setStatus(frame);

    map.addSource('stations', { type: 'geojson', data: toGeoJSON(frame) as never });
    const colorByBand: unknown[] = ['match', ['get', 'b']];
    PM25_RAMP.forEach((c, i) => colorByBand.push(i, c));
    colorByBand.push('#888888');

    map.addLayer({
      id: 'stations',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-color': colorByBand as never,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['+', 2, ['*', ['get', 'b'], 0.35]], 6, ['+', 4, ['*', ['get', 'b'], 0.6]], 12, 9],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#edf1f7', '#090d15'],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 0.8],
      },
    });

    let selected: number | null = null;
    const select = (id: number | null) => {
      if (selected !== null) map.setFeatureState({ source: 'stations', id: selected }, { selected: false });
      selected = id;
      if (id !== null) map.setFeatureState({ source: 'stations', id }, { selected: true });
    };

    map.on('click', 'stations', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || !frame) return;
      const props = f.properties as unknown as StationProps;
      const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
      select(props.id);
      showStation(props, coords, frame, index);
    });
    map.on('mouseenter', 'stations', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'stations', () => (map.getCanvas().style.cursor = ''));

    $('st-close').addEventListener('click', () => {
      $('station').hidden = true;
      select(null);
    });
    $<HTMLInputElement>('layer-stations').addEventListener('change', (e) => {
      map.setLayoutProperty('stations', 'visibility', (e.target as HTMLInputElement).checked ? 'visible' : 'none');
    });

    // Keep the source reference for later updates (time slider arrives in block 2).
    void (map.getSource('stations') as GeoJSONSource | undefined);
  });
}

function showStation(p: StationProps, coords: [number, number], frame: StationFrame, index: StationIndex | null): void {
  const meta = index?.stations[String(p.id)];
  const [name, locality, country, provider] = meta ?? ['', '', '', ''];
  $('st-name').textContent = name || `Station ${p.id}`;
  $('st-place').textContent = ['Station', [locality, country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  $('st-value').textContent = p.v.toFixed(p.v < 10 ? 1 : 0);
  const band = bands()[p.b];
  $('st-swatch').style.background = band.color;
  const x = timesGuideline(p.v);
  $('st-who-text').textContent =
    x <= 1 ? 'Within the WHO 24-hour guideline level' : `${x.toFixed(1)} times the WHO 24-hour guideline level`;
  $('st-age').textContent = describeAge(minutesAgo(frame.generated, p.age));
  $('st-provider').textContent = provider || 'Not listed';
  $('st-coords').textContent = `${coords[1].toFixed(3)}, ${coords[0].toFixed(3)}`;
  $<HTMLAnchorElement>('st-link').href = `https://explore.openaq.org/locations/${p.id}`;
  $('station').hidden = false;
}

main().catch((err) => {
  console.error(err);
  showNotice('Something went wrong while loading the map.');
});
