import { Map as MapLibreMap, setWorkerUrl, type GeoJSONSource, type ImageSource, type MapLayerMouseEvent } from 'maplibre-gl';
// Let Vite bundle MapLibre's worker so its URL survives the production build.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

import { bands, POLLUTANTS, timesGuideline, type Pollutant } from './bands';
import { loadBaseStyle } from './basemap';
import { sparkPath } from './sparkline';
import {
  describeAge, fetchJson, historyToGeoJSON, minutesAgo, toGeoJSON, validateFrame,
  type Coords, type HistoryFrame, type PointCollection, type StationFrame, type StationIndex, type StationProps,
} from './stations';
import { buildSlots, defaultSlot, formatSlot, seriesShard, type ModelManifest, type Slot, type StationManifest } from './timeline';
import { loadWind, speedAndFrom, WindLayer, type WindField } from './wind';

const DATA = 'data/';
const EMPTY: PointCollection = { type: 'FeatureCollection', features: [] };
const SVG = 'http://www.w3.org/2000/svg';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cache = new Map<string, Promise<unknown>>();
function load<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    const p = fetchJson<T>(DATA + path);
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return cache.get(path) as Promise<T>;
}

interface PollutantData {
  latest: StationFrame | null;
  index: StationIndex | null;
  manifest: StationManifest | null;
}

const state = {
  pollutant: 'pm25' as Pollutant,
  data: {} as Record<Pollutant, PollutantData>,
  model: null as ModelManifest | null,
  slots: [] as Slot[],
  slot: 0,
  layers: { stations: true, model: true, wind: true },
  wind: null as WindField | null,
  windLayer: null as WindLayer | null,
  selected: null as number | null,
  playing: 0 as number,
};

function showNotice(text: string | null): void {
  const el = $('notice');
  el.hidden = !text;
  el.textContent = text ?? '';
}

function renderLegend(): void {
  const spec = POLLUTANTS[state.pollutant];
  $('legend-title').textContent = `${spec.label}, µg/m³`;
  const ramp = $('legend-ramp');
  const labels = $('legend-labels');
  ramp.replaceChildren();
  labels.replaceChildren();
  const bs = bands(spec.edges, spec.ramp);
  ramp.style.gridTemplateColumns = labels.style.gridTemplateColumns = `repeat(${bs.length}, minmax(0, 1fr))`;
  for (const b of bs) {
    const sw = document.createElement('span');
    sw.style.background = b.color;
    sw.title = `${b.label} µg/m³`;
    ramp.append(sw);
    const lab = document.createElement('span');
    lab.textContent = b.label;
    labels.append(lab);
  }
  document.querySelectorAll<HTMLButtonElement>('[data-pollutant]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.pollutant === state.pollutant));
  });
  const modelAvailable = state.pollutant === 'pm25' && !!state.model?.frames.length;
  $<HTMLInputElement>('layer-model').disabled = !modelAvailable;
  $('model-sub').textContent = state.pollutant === 'pm25'
    ? (state.model?.frames.length ? 'CAMS, updated twice a day' : 'Not available yet')
    : 'PM2.5 only for now';
}

async function loadPollutant(p: Pollutant): Promise<PollutantData> {
  if (state.data[p]) return state.data[p];
  const [latest, manifest] = await Promise.all([
    load<unknown>(`stations-${p}.json`).then(validateFrame).catch(() => null),
    load<StationManifest>(`stations/${p}/manifest.json`).catch(() => null),
  ]);
  const data: PollutantData = { latest, manifest, index: null };
  load<StationIndex>(`stations-${p}-index.json`).then((i) => (data.index = i)).catch(() => undefined);
  state.data[p] = data;
  return data;
}

async function stationsAt(slot: Slot | undefined, d: PollutantData): Promise<PointCollection> {
  const edges = POLLUTANTS[state.pollutant].edges;
  if (!slot) return d.latest ? toGeoJSON(d.latest, edges) : EMPTY;
  if (!slot.stationFile || !d.manifest) return EMPTY;
  if (d.latest && Date.parse(d.manifest.latest) === slot.t) return toGeoJSON(d.latest, edges);
  const [frame, coords] = await Promise.all([load<HistoryFrame>(slot.stationFile), load<Coords>(d.manifest.coords)]);
  return historyToGeoJSON(frame, coords, edges);
}

function setStatus(): void {
  const d = state.data[state.pollutant];
  const slot = state.slots[state.slot];
  if (d?.latest) {
    const time = new Date(d.latest.generated).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    $('status').textContent = `Updated ${time} UTC`;
    $('station-count').textContent = `${d.latest.count.toLocaleString()} stations reported in the last 6 hours.`;
  } else {
    $('status').textContent = 'No station data';
    $('station-count').textContent = '';
  }
  $('slot-time').textContent = slot ? formatSlot(slot.t) : '';
  $('slot-kind').textContent = !slot ? '' : slot.measured
    ? (slot.stationFile ? 'Measured' : 'No station data this hour')
    : 'Forecast: model estimate';
}

async function main(): Promise<void> {
  // In dev, MapLibre finds its own worker next to its module (see optimizeDeps in vite.config).
  if (import.meta.env.PROD) setWorkerUrl(workerUrl);
  setupLegendToggle();

  const style = await loadBaseStyle().catch((err) => {
    console.error(err);
    showNotice('The base map could not load. Data layers are still shown.');
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
  if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { atlas: { map, state } });
  $('zoom-in').addEventListener('click', () => map.zoomIn());
  $('zoom-out').addEventListener('click', () => map.zoomOut());

  const modelPromise = load<ModelManifest>('model/pm25/manifest.json').catch(() => null);
  const firstData = loadPollutant('pm25');

  map.once('style.load', async () => {
    const [model, d] = await Promise.all([modelPromise, firstData]);
    state.model = model;
    if (!d.latest && !model?.frames.length) {
      $('status').textContent = 'No data';
      showNotice('Air quality data is not available right now. It refreshes every hour.');
    }

    if (model?.frames.length) {
      map.addSource('model', { type: 'image', url: DATA + model.frames[0].file, coordinates: model.bounds });
      map.addLayer({ id: 'model', type: 'raster', source: 'model', paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0, 'raster-resampling': 'linear' } });
    }
    map.addSource('stations', { type: 'geojson', data: EMPTY as never });
    map.addLayer({
      id: 'stations',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-color': colorExpression() as never,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, ['+', 2, ['*', ['get', 'b'], 0.35]], 6, ['+', 4, ['*', ['get', 'b'], 0.6]], 12, 9],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#edf1f7', '#090d15'],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.5, 0.8],
      },
    });

    const select = (id: number | null) => {
      if (state.selected !== null) map.setFeatureState({ source: 'stations', id: state.selected }, { selected: false });
      state.selected = id;
      if (id !== null) map.setFeatureState({ source: 'stations', id }, { selected: true });
    };

    let drawSeq = 0;
    const draw = async () => {
      const seq = ++drawSeq;
      const slot = state.slots[state.slot];
      const d = state.data[state.pollutant];
      const fc = await stationsAt(slot, d).catch((err) => {
        console.warn('station frame', err);
        return EMPTY;
      });
      if (seq !== drawSeq) return; // a newer draw started
      (map.getSource('stations') as GeoJSONSource).setData(fc as never);
      map.setPaintProperty('stations', 'circle-color', colorExpression() as never);
      map.setLayoutProperty('stations', 'visibility', state.layers.stations ? 'visible' : 'none');
      if (state.selected !== null && fc.features.some((f) => f.id === state.selected)) {
        map.setFeatureState({ source: 'stations', id: state.selected }, { selected: true });
      }
      if (map.getLayer('model')) {
        const show = state.layers.model && state.pollutant === 'pm25' && !!slot?.modelFile;
        map.setLayoutProperty('model', 'visibility', show ? 'visible' : 'none');
        if (show) (map.getSource('model') as ImageSource).updateImage({ url: DATA + slot!.modelFile! });
      }
      if (state.windLayer && state.wind) {
        const near = !slot || Math.abs(slot.t - Date.parse(state.wind.meta.valid)) <= 3 * 3_600_000;
        state.windLayer.setEnabled(state.layers.wind && near);
        $('wind-sub').textContent = near ? windLabel(state.wind) : 'Shown for the current hours only';
      }
      setStatus();
      renderSlider();
    };

    const rebuild = async () => {
      const d = await loadPollutant(state.pollutant);
      state.slots = buildSlots(d.manifest, state.pollutant === 'pm25' ? state.model : null);
      state.slot = defaultSlot(state.slots);
      const range = $<HTMLInputElement>('slot');
      range.max = String(Math.max(state.slots.length - 1, 0));
      range.disabled = state.slots.length < 2;
      $<HTMLButtonElement>('play').disabled = state.slots.length < 2;
      renderLegend();
      await draw();
    };

    function renderSlider() {
      const range = $<HTMLInputElement>('slot');
      range.value = String(state.slot);
      const slot = state.slots[state.slot];
      range.setAttribute('aria-valuetext', slot ? `${formatSlot(slot.t)}, ${slot.measured ? 'measured' : 'forecast'}` : '');
      const firstForecast = state.slots.findIndex((s) => !s.measured);
      const pct = firstForecast < 0 ? 100 : (firstForecast / Math.max(state.slots.length - 1, 1)) * 100;
      $('track').style.setProperty('--now', `${pct}%`);
    }

    $<HTMLInputElement>('slot').addEventListener('input', (e) => {
      state.slot = Number((e.target as HTMLInputElement).value);
      void draw();
    });
    $<HTMLButtonElement>('play').addEventListener('click', () => {
      const btn = $<HTMLButtonElement>('play');
      if (state.playing) {
        clearInterval(state.playing);
        state.playing = 0;
        btn.setAttribute('aria-label', 'Play the timeline');
        btn.classList.remove('on');
        return;
      }
      btn.setAttribute('aria-label', 'Pause the timeline');
      btn.classList.add('on');
      state.playing = window.setInterval(() => {
        state.slot = (state.slot + 1) % Math.max(state.slots.length, 1);
        void draw();
      }, 650);
    });
    document.querySelectorAll<HTMLButtonElement>('[data-pollutant]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const p = btn.dataset.pollutant as Pollutant;
        if (p === state.pollutant) return;
        state.pollutant = p;
        select(null);
        $('station').hidden = true;
        void rebuild();
      }),
    );
    $<HTMLInputElement>('layer-stations').addEventListener('change', (e) => {
      state.layers.stations = (e.target as HTMLInputElement).checked;
      void draw();
    });
    $<HTMLInputElement>('layer-model').addEventListener('change', (e) => {
      state.layers.model = (e.target as HTMLInputElement).checked;
      void draw();
    });

    map.on('click', 'stations', (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as unknown as StationProps;
      const coords = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
      select(props.id);
      void showStation(props, coords);
    });
    map.on('mouseenter', 'stations', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'stations', () => (map.getCanvas().style.cursor = ''));
    $('st-close').addEventListener('click', () => {
      $('station').hidden = true;
      select(null);
    });

    await rebuild();

    loadWind(DATA)
      .then((field) => {
        state.wind = field;
        state.windLayer = new WindLayer(map, field, $<HTMLCanvasElement>('wind'));
        $<HTMLInputElement>('layer-wind').disabled = false;
        void draw();
      })
      .catch((err) => {
        console.warn('wind', err);
        $('wind-sub').textContent = 'Not available right now';
      });
    $<HTMLInputElement>('layer-wind').addEventListener('change', (e) => {
      state.layers.wind = (e.target as HTMLInputElement).checked;
      void draw();
    });
  });

  setupSourcesDialog();
}

function windLabel(field: WindField): string {
  const t = new Date(field.meta.valid).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `NOAA GFS, valid ${t} UTC`;
}

function colorExpression(): unknown[] {
  const expr: unknown[] = ['match', ['get', 'b']];
  POLLUTANTS[state.pollutant].ramp.forEach((c, i) => expr.push(i, c));
  expr.push('#888888');
  return expr;
}

async function showStation(p: StationProps, coords: [number, number]): Promise<void> {
  const spec = POLLUTANTS[state.pollutant];
  const d = state.data[state.pollutant];
  const meta = d.index?.stations[String(p.id)];
  const [name, locality, country, provider] = meta ?? ['', '', '', ''];
  $('st-name').textContent = name || `Station ${p.id}`;
  $('st-place').textContent = ['Station', [locality, country].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  $('st-value').textContent = p.v.toFixed(p.v < 10 ? 1 : 0);
  $('st-unit').textContent = `µg/m³ ${spec.label}`;
  $('st-swatch').style.background = bands(spec.edges, spec.ramp)[p.b].color;
  const x = timesGuideline(p.v, spec.guideline);
  $('st-who-text').textContent = x <= 1 ? 'Within the WHO 24-hour guideline level' : `${x.toFixed(1)} times the WHO 24-hour guideline level`;
  const slot = state.slots[state.slot];
  $('st-age').textContent = p.age >= 0 && d.latest ? describeAge(minutesAgo(d.latest.generated, p.age)) : slot ? formatSlot(slot.t) : '';
  $('st-provider').textContent = provider || 'Not listed';
  $('st-coords').textContent = `${coords[1].toFixed(3)}, ${coords[0].toFixed(3)}`;
  const uv = state.wind?.sample(coords[0], coords[1]);
  if (uv) {
    const w = speedAndFrom(uv[0], uv[1]);
    $('st-wind').textContent = `${w.speed.toFixed(1)} m/s from ${w.from}`;
  } else $('st-wind').textContent = 'Not available';
  $<HTMLAnchorElement>('st-link').href = `https://explore.openaq.org/locations/${p.id}`;
  $('station').hidden = false;

  const fig = $('st-spark');
  fig.hidden = true;
  if (!d.manifest) return;
  const shard = seriesShard(p.id, d.manifest.shards);
  const series = await load<{ hours: string[]; series: Record<string, (number | null)[]> }>(
    d.manifest.series.replace('{shard}', String(shard)),
  ).catch(() => null);
  const values = series?.series[String(p.id)];
  if (!values || state.selected !== p.id) return;
  drawSpark(values, spec.guideline);
  fig.hidden = false;
}

function drawSpark(values: (number | null)[], guideline: number): void {
  const svg = $('st-spark-svg') as unknown as SVGSVGElement;
  const w = 290;
  const h = 84;
  const s = sparkPath(values, w, h, guideline);
  svg.replaceChildren();
  const mk = (tag: string, attrs: Record<string, string | number>) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
    return el;
  };
  const gy = s.y(guideline);
  mk('line', { x1: 0, x2: w, y1: gy, y2: gy, stroke: '#8792a5', 'stroke-dasharray': '3 3', 'stroke-width': 1 });
  mk('text', { x: w, y: gy - 4, fill: '#aab4c4', 'font-size': 10, 'text-anchor': 'end' }).textContent = 'WHO 24-h guideline';
  mk('path', { d: s.d, fill: 'none', stroke: '#ff936d', 'stroke-width': 2, 'stroke-linejoin': 'round' });
  if (s.last) mk('circle', { cx: s.last.x, cy: s.last.y, r: 4, fill: '#ff936d', stroke: '#0e131d', 'stroke-width': 2 });
}

function setupLegendToggle(): void {
  const btn = $<HTMLButtonElement>('legend-toggle');
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    $('controls').classList.toggle('open', open);
  });
}

function setupSourcesDialog(): void {
  const dialog = $<HTMLDialogElement>('sources');
  const open = () => {
    const providers = $('providers');
    const atts = $('attributions');
    providers.replaceChildren();
    atts.replaceChildren();
    const indexes = Object.values(state.data).map((d) => d.index).filter((i): i is StationIndex => !!i);
    const provCount = new Map<string, number>();
    const attUrl = new Map<string, string | null>();
    for (const idx of indexes) {
      idx.providers.forEach((p) => provCount.set(p.name, Math.max(provCount.get(p.name) ?? 0, p.stations)));
      idx.attributions.forEach((a) => attUrl.set(a.name, a.url));
    }
    if (!provCount.size) providers.textContent = 'Provider list is still loading.';
    [...provCount].sort((a, b) => b[1] - a[1]).forEach(([name, n]) => {
      const li = document.createElement('li');
      li.textContent = `${name} (${n.toLocaleString()} stations)`;
      providers.append(li);
    });
    [...attUrl].sort().forEach(([name, url]) => {
      const li = document.createElement('li');
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = name;
        li.append(a);
      } else li.textContent = name;
      atts.append(li);
    });
    dialog.showModal();
  };
  document.querySelectorAll('[data-open-sources]').forEach((b) => b.addEventListener('click', open));
  $('sources-close').addEventListener('click', () => dialog.close());
}

main().catch((err) => {
  console.error(err);
  showNotice('Something went wrong while loading the map.');
});
