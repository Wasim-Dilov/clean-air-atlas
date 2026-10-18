/** Hash routes: #air (default), #grid, #sim, #methods. */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { binIndex, GROUPS, GridMixLayer, METRICS, mixFor, type EmberData, type Metric } from './gridmix';
import { renderMethods } from './methods';
import { SimulatorView } from './simulator';

export type View = 'air' | 'grid' | 'sim' | 'methods';
const VIEWS: View[] = ['air', 'grid', 'sim', 'methods'];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function currentView(): View {
  const v = location.hash.replace('#', '').split('?')[0] as View;
  return VIEWS.includes(v) ? v : 'air';
}

export interface AppHooks {
  map: MapLibreMap;
  /** Resolves once the base style has loaded and layers can be added. */
  ready: Promise<void>;
  /** Show or hide the air layers (stations, model, wind) and redraw them. */
  setAir: (on: boolean) => void;
}

export function setupRouter(hooks: AppHooks): void {
  let grid: GridMixLayer | null = null;
  let ember: EmberData | null = null;
  let sim: SimulatorView | null = null;
  let selectedIso: string | null = null;

  const ensureGrid = async () => {
    if (grid) return grid;
    const [mod] = await Promise.all([import('../../../data/static/ember_electricity.json'), hooks.ready]);
    if (grid) return grid;
    ember = mod.default as unknown as EmberData;
    grid = new GridMixLayer(hooks.map, ember, (iso3) => {
      selectedIso = iso3;
      renderCountry();
    });
    buildYears();
    renderGridLegend();
    return grid;
  };
  const ensureSim = () => (sim ??= new SimulatorView());

  function buildYears() {
    const box = $('years');
    box.replaceChildren();
    for (const y of ember!.years) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = String(y);
      b.addEventListener('click', () => {
        grid!.year = y;
        grid!.recolor();
        syncYears();
        renderCountry();
      });
      box.append(b);
    }
    syncYears();
  }

  function syncYears() {
    $('years').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.textContent) === grid!.year)));
  }

  function renderGridLegend() {
    const m = METRICS[grid!.metric];
    $('grid-legend-title').textContent = `${m.label} of electricity`;
    $('grid-legend-note').textContent = `${m.legend}, in percent. Grey: no data.`;
    const ramp = $('grid-ramp');
    const labels = $('grid-ramp-labels');
    ramp.replaceChildren();
    labels.replaceChildren();
    m.ramp.forEach((c, i) => {
      const sw = document.createElement('span');
      sw.style.background = c;
      ramp.append(sw);
      const l = document.createElement('span');
      l.textContent = i === 0 ? `≤${m.edges[0]}` : i === m.edges.length ? `>${m.edges.at(-1)}` : `${m.edges[i - 1]}–${m.edges[i]}`;
      labels.append(l);
    });
  }

  function renderCountry() {
    const panel = $('country');
    if (!selectedIso || !ember || !grid) {
      panel.hidden = true;
      return;
    }
    const mix = mixFor(ember, selectedIso, grid.year);
    if (!mix) {
      panel.hidden = true;
      return;
    }
    const name = ember.countries[selectedIso].name;
    $('cm-name').textContent = name;
    $('cm-year').textContent = Number(mix.year) === grid.year ? `Electricity mix, ${mix.year}` : `Electricity mix, ${mix.year} (latest available)`;
    const stack = $('cm-stack');
    const legend = $('cm-stack-legend');
    stack.replaceChildren();
    legend.replaceChildren();
    const parts: string[] = [];
    (Object.keys(GROUPS) as (keyof typeof GROUPS)[]).forEach((g) => {
      const pct = mix.groups[g];
      parts.push(`${GROUPS[g].label} ${pct.toFixed(0)}%`);
      if (pct > 0) {
        const seg = document.createElement('span');
        seg.style.width = `${pct}%`;
        seg.style.background = GROUPS[g].color;
        stack.append(seg);
      }
      const item = document.createElement('span');
      const sw = document.createElement('i');
      sw.style.background = GROUPS[g].color;
      item.append(sw, `${GROUPS[g].label} ${pct.toFixed(pct < 1 && pct > 0 ? 1 : 0)}%`);
      legend.append(item);
    });
    stack.setAttribute('aria-label', `Share of generation: ${parts.join(', ')}`);

    const fuels = $('cm-fuels');
    fuels.replaceChildren();
    for (const s of [...mix.shares].sort((a, b) => b.twh - a.twh)) {
      const row = document.createElement('div');
      row.className = 'fuel-row';
      const n = document.createElement('span');
      n.textContent = s.fuel;
      const bar = document.createElement('span');
      bar.className = 'fuel-track';
      if (s.pct > 0) {
        const fill = document.createElement('span');
        fill.style.width = `${s.pct}%`;
        fill.style.background = GROUPS[s.group].color;
        bar.append(fill);
      }
      const v = document.createElement('span');
      v.className = 'num';
      v.textContent = `${s.pct < 1 && s.pct > 0 ? s.pct.toFixed(1) : s.pct.toFixed(0)}%`;
      row.append(n, bar, v);
      fuels.append(row);
    }
    $('cm-total').textContent = `${mix.total.toLocaleString('en-GB', { maximumFractionDigits: 1 })} TWh`;
    $('cm-intensity').textContent = mix.intensity === null ? 'Not available' : `${Math.round(mix.intensity).toLocaleString('en-GB')} gCO₂e/kWh`;
    panel.hidden = false;
  }

  $('cm-close').addEventListener('click', () => {
    selectedIso = null;
    grid?.select(null);
    renderCountry();
  });
  $('cm-simulate').addEventListener('click', (e) => {
    e.preventDefault();
    if (!selectedIso) return;
    const iso3 = selectedIso;
    location.hash = '#sim';
    void ensureSim().openCountry(iso3);
  });
  document.querySelectorAll<HTMLInputElement>('input[name="grid-metric"]').forEach((r) =>
    r.addEventListener('change', () => {
      if (!grid || !r.checked) return;
      grid.metric = r.value as Metric;
      grid.recolor();
      renderGridLegend();
    }),
  );

  const apply = async () => {
    const view = currentView();
    document.body.dataset.view = view;
    document.querySelectorAll<HTMLAnchorElement>('.tabs a').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const onMap = view === 'air' || view === 'grid';
    document.querySelector<HTMLElement>('.layout')!.hidden = !onMap;
    $('view-sim').hidden = view !== 'sim';
    $('view-methods').hidden = view !== 'methods';
    hooks.setAir(view === 'air');
    if (view === 'air') $('country').hidden = true;
    if (view === 'grid') {
      $('station').hidden = true;
      (await ensureGrid()).setVisible(true);
      renderCountry();
    } else grid?.setVisible(false);
    if (onMap) requestAnimationFrame(() => hooks.map.resize());
    if (view === 'sim') void ensureSim().show();
    if (view === 'methods') renderMethods($('view-methods'));
    window.scrollTo(0, 0);
  };
  window.addEventListener('hashchange', () => void apply());
  void apply();
}

export { binIndex };
