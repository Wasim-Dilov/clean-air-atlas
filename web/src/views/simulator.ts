/** Simulator view: scenario inputs, a typical-day dispatch chart and results as ranges. */

import presetsJson from '../../../data/static/presets.json';
import { POLLUTANTS, type Range } from '../sim/factors';
import { simulate, type EmberCountry, type PvProfile, type Result, type Scenario, type Source } from '../sim/simulate';

interface PvData {
  credit: string;
  sites: Record<string, { name: string; hourly_w_per_kwp: number[] }>;
  countries: Record<string, { monthly_day_w_per_kwp: number[][] }>;
}

interface EmberData {
  fuels: string[];
  countries: Record<string, EmberCountry>;
}

const presets = presetsJson as unknown as {
  battery_defaults: { round_trip: number; usable_dod: number };
  presets: Record<string, {
    label: string; country: string; pv_site?: string; example_note: string;
    source: { type: Source['type']; count?: number; kw_each?: number; mw?: number; fuel?: 'Coal' | 'Gas' | 'Other fossil'; start_hour?: number; end_hour?: number };
    solar_mwp: number; battery: { power_mw: number; energy_mwh: number };
  }>;
};

const SVG = 'http://www.w3.org/2000/svg';
const COLORS = { solar: '#c98500', battery: '#199e70', fossil: '#d95926' }; // categorical slots 4, 3, 2 (adjacent pairs validated)
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface SimState {
  preset: string;
  country: string;
  pvSite: string | null;
  source: Source;
  solarMWp: number;
  powerMW: number;
  energyMWh: number;
  roundTrip: number;
  usableDoD: number;
  month: number; // -1 = year average
}

function fromPreset(key: string): SimState {
  const p = presets.presets[key];
  const s = p.source;
  const source: Source = s.type === 'gensets'
    ? { type: 'gensets', count: s.count!, kwEach: s.kw_each!, startHour: s.start_hour!, endHour: s.end_hour! }
    : s.type === 'plant' ? { type: 'plant', fuel: s.fuel!, mw: s.mw! }
      : { type: 'grid', mw: s.mw!, startHour: s.start_hour ?? 0, endHour: s.end_hour ?? 24 };
  return {
    preset: key, country: p.country, pvSite: p.pv_site ?? null, source,
    solarMWp: p.solar_mwp, powerMW: p.battery.power_mw, energyMWh: p.battery.energy_mwh,
    roundTrip: presets.battery_defaults.round_trip, usableDoD: presets.battery_defaults.usable_dod, month: -1,
  };
}

const decimals = (step: number) => (Number.isInteger(step) ? 0 : String(step).split('.')[1].length);

export const fmt = (v: number, digits = 0) =>
  v.toLocaleString('en-GB', { maximumFractionDigits: digits, minimumFractionDigits: digits });

export function fmtTonnes(v: number): string {
  if (v >= 100) return fmt(v);
  if (v >= 10) return fmt(v, 1);
  return fmt(v, 2);
}

export function fmtEur(v: number): string {
  if (v >= 1e6) return `€${fmt(v / 1e6, v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `€${fmt(v / 1e3, 0)}k`;
  return `€${fmt(v)}`;
}

export class SimulatorView {
  state: SimState;
  private pv: PvData | null = null;
  private ember: EmberData | null = null;
  private ready: Promise<void>;
  private timer = 0;

  constructor() {
    this.state = fromPreset(Object.keys(presets.presets)[0]);
    this.ready = Promise.all([
      import('../../../data/static/pv_profiles.json').then((m) => (this.pv = m.default as unknown as PvData)),
      import('../../../data/static/ember_electricity.json').then((m) => (this.ember = m.default as unknown as EmberData)),
    ]).then(() => this.buildControls());
  }

  /** Open with a country's grid average (from the Grid mix view). */
  async openCountry(iso3: string): Promise<void> {
    await this.ready;
    const base = fromPreset('grid');
    this.state = { ...base, country: iso3, pvSite: null };
    this.syncControls();
    this.run();
  }

  async show(): Promise<void> {
    await this.ready;
    this.run();
  }

  private buildControls(): void {
    const presetSel = $<HTMLSelectElement>('sim-preset');
    for (const [k, p] of Object.entries(presets.presets)) presetSel.append(new Option(p.label, k));
    presetSel.addEventListener('change', () => {
      this.state = fromPreset(presetSel.value);
      this.syncControls();
      this.run();
    });

    const countrySel = $<HTMLSelectElement>('sim-country');
    const names = Object.entries(this.ember!.countries)
      .filter(([iso3]) => this.pv!.countries[iso3])
      .sort((a, b) => a[1].name.localeCompare(b[1].name));
    for (const [iso3, c] of names) countrySel.append(new Option(c.name, iso3));
    countrySel.addEventListener('change', () => {
      this.state.country = countrySel.value;
      this.state.pvSite = null; // a country profile replaces the preset site
      this.run();
    });

    document.querySelectorAll<HTMLButtonElement>('[data-sim-source]').forEach((b) =>
      b.addEventListener('click', () => {
        const t = b.dataset.simSource as Source['type'];
        const s = this.state.source;
        if (t === s.type) return;
        const load = s.type === 'gensets' ? (s.count * s.kwEach) / 1000 : s.mw;
        this.state.source = t === 'gensets'
          ? { type: 'gensets', count: 1000, kwEach: Math.max(0.5, (load * 1000) / 1000), startHour: 6, endHour: 24 }
          : t === 'plant' ? { type: 'plant', fuel: 'Gas', mw: load } : { type: 'grid', mw: load, startHour: 0, endHour: 24 };
        this.syncControls();
        this.run();
      }),
    );

    $<HTMLSelectElement>('sim-month').addEventListener('change', (e) => {
      this.state.month = Number((e.target as HTMLSelectElement).value);
      this.run();
    });
    this.syncControls();
  }

  private slider(id: string, label: string, min: number, max: number, step: number, value: number, unit: string, set: (v: number) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    const head = document.createElement('span');
    head.className = 'slider-head';
    const name = document.createElement('span');
    name.textContent = label;
    const val = document.createElement('output');
    val.htmlFor = id;
    const show = (v: number) =>
      (val.textContent = unit === '%' ? `${Math.round(v * 100)}%` : `${fmt(v, decimals(step))}${unit}`);
    show(value);
    head.append(name, val);
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(value) });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      show(v);
      set(v);
      this.schedule();
    });
    wrap.append(head, input);
    return wrap;
  }

  private syncControls(): void {
    const s = this.state;
    $<HTMLSelectElement>('sim-preset').value = s.preset;
    $<HTMLSelectElement>('sim-country').value = s.country;
    document.querySelectorAll<HTMLButtonElement>('[data-sim-source]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.simSource === s.source.type)),
    );
    const src = $('sim-source-inputs');
    src.replaceChildren();
    const st = s.source;
    if (st.type === 'gensets') {
      src.append(
        this.slider('sim-count', 'Generators', 10, 5000, 10, st.count, '', (v) => (st.count = v)),
        this.slider('sim-kw', 'Average output each', 0.5, 50, 0.25, st.kwEach, ' kW', (v) => (st.kwEach = v)),
        this.slider('sim-start', 'Running from', 0, 23, 1, st.startHour, ':00', (v) => (st.startHour = v)),
        this.slider('sim-end', 'Running until', 1, 24, 1, st.endHour, ':00', (v) => (st.endHour = v)),
      );
    } else if (st.type === 'plant') {
      const sel = document.createElement('select');
      for (const f of ['Coal', 'Gas', 'Other fossil']) sel.append(new Option(f === 'Other fossil' ? 'Oil' : f, f));
      sel.value = st.fuel;
      sel.addEventListener('change', () => {
        st.fuel = sel.value as typeof st.fuel;
        this.run();
      });
      const lab = document.createElement('label');
      lab.className = 'field';
      lab.append('Plant fuel', sel);
      src.append(lab, this.slider('sim-mw', 'Output replaced (running all day)', 1, 500, 1, st.mw, ' MW', (v) => (st.mw = v)));
    } else {
      src.append(
        this.slider('sim-mw', 'Grid power replaced', 0.5, 200, 0.5, st.mw, ' MW', (v) => (st.mw = v)),
        this.slider('sim-start', 'From', 0, 23, 1, st.startHour, ':00', (v) => (st.startHour = v)),
        this.slider('sim-end', 'Until', 1, 24, 1, st.endHour, ':00', (v) => (st.endHour = v)),
      );
    }
    const size = $('sim-sizing');
    size.replaceChildren(
      this.slider('sim-solar', 'Solar installed', 0, 400, 1, s.solarMWp, ' MWp', (v) => (s.solarMWp = v)),
      this.slider('sim-power', 'Battery power', 0, 200, 1, s.powerMW, ' MW', (v) => (s.powerMW = v)),
      this.slider('sim-energy', 'Battery energy', 0, 800, 2, s.energyMWh, ' MWh', (v) => (s.energyMWh = v)),
      this.slider('sim-rte', 'Round-trip efficiency', 0.6, 0.98, 0.01, s.roundTrip, '%', (v) => (s.roundTrip = v)),
      this.slider('sim-dod', 'Usable depth of discharge', 0.5, 1, 0.05, s.usableDoD, '%', (v) => (s.usableDoD = v)),
    );
    $('sim-example').textContent = presets.presets[s.preset]?.example_note ?? '';
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(), 60);
  }

  run(): void {
    if (!this.pv || !this.ember) return;
    const s = this.state;
    const pv: PvProfile = s.pvSite
      ? { hourly: this.pv.sites[s.pvSite].hourly_w_per_kwp }
      : { monthly: this.pv.countries[s.country]?.monthly_day_w_per_kwp };
    if (!pv.hourly && !pv.monthly) {
      $('sim-notes').textContent = 'No solar profile for this country yet.';
      return;
    }
    const scenario: Scenario = {
      country: s.country, source: s.source, solarMWp: s.solarMWp,
      battery: { powerMW: s.powerMW, energyMWh: s.energyMWh, roundTrip: s.roundTrip, usableDoD: s.usableDoD },
    };
    const r = simulate(scenario, pv, this.ember.countries, this.ember.fuels);
    this.render(r);
  }

  private render(r: Result): void {
    const s = this.state;
    const c = this.ember!.countries[s.country];
    $('sim-place').textContent = s.pvSite ? this.pv!.sites[s.pvSite].name : `${c?.name ?? s.country} (national solar profile)`;
    drawDay(r, s.month);

    const t = r.dispatch.totals;
    const rows: [string, string][] = [
      ['Fossil power displaced', `${fmt(t.displaced)} MWh a year`],
      ['Share of fossil power replaced', `${fmt(t.load > 0 ? (t.displaced / t.load) * 100 : 0)}%`],
      ['Solar output used', `${fmt(t.solar > 0 ? ((t.solar - t.curtailed) / t.solar) * 100 : 0)}%`],
      ['Battery cycles', `${fmt(t.cycles)} a year`],
    ];
    const dl = $('sim-key');
    dl.replaceChildren();
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }

    const ranges = $('sim-ranges');
    ranges.replaceChildren();
    const max = Math.max(...POLLUTANTS.map((p) => r.tonnes[p].high), 1e-9);
    for (const p of POLLUTANTS) ranges.append(rangeRow(p === 'NOx' ? 'NOₓ' : p === 'SO2' ? 'SO₂' : 'PM2.5', 'tonnes a year', r.tonnes[p], max, fmtTonnes));

    const d = r.damage;
    const basis = d.basis === 'transfer' ? 'Rough transfer from European values' : d.basis === 'defra' ? 'UK Defra 2025 values, converted to euros' : 'EEA values for this country';
    $('sim-damage').textContent = `${fmtEur(d.total.low)} to ${fmtEur(d.total.high)} a year (central ${fmtEur(d.total.central)})`;
    $('sim-damage-basis').textContent = `${basis}. Original currency ${d.currency}, ${d.priceYear} prices.`;

    const notes = [...r.notes];
    if (s.source.type === 'grid' && c && r.gridYear) {
      const intensity = c.years[r.gridYear].intensity;
      notes.unshift(`Grid mix: ${c.name}, ${r.gridYear} (Ember).${intensity ? ` Carbon intensity ${fmt(intensity)} gCO₂e/kWh.` : ''} Gains are small where the grid is already clean.`);
    }
    $('sim-notes').textContent = notes.join(' ');
  }
}

function rangeRow(name: string, unit: string, r: Range, max: number, f: (v: number) => string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'range-row';
  const label = document.createElement('span');
  label.className = 'range-name';
  const n = document.createElement('span');
  n.textContent = name;
  const u = document.createElement('span');
  u.className = 'muted';
  u.textContent = unit;
  label.append(n, u);
  const bar = document.createElement('span');
  bar.className = 'range-bar';
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `${name}: low ${f(r.low)}, central ${f(r.central)}, high ${f(r.high)} ${unit}`);
  const band = document.createElement('span');
  band.className = 'range-band';
  band.style.left = `${(r.low / max) * 100}%`;
  band.style.width = `${Math.max(((r.high - r.low) / max) * 100, 0.5)}%`;
  const mid = document.createElement('span');
  mid.className = 'range-mid';
  mid.style.left = `${(r.central / max) * 100}%`;
  bar.append(band, mid);
  const nums = document.createElement('span');
  nums.className = 'range-nums';
  const lo = document.createTextNode(`${f(r.low)} · `);
  const ce = document.createElement('strong');
  ce.textContent = f(r.central);
  const hi = document.createTextNode(` · ${f(r.high)}`);
  nums.append(lo, ce, hi);
  row.append(label, bar, nums);
  return row;
}

/** Average day (or a month's average day) as stacked areas: solar used, battery, fossil left. */
function drawDay(r: Result, month: number): void {
  const d = r.dispatch;
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const start = month < 0 ? 0 : days.slice(0, month).reduce((a, b) => a + b, 0) * 24;
  const len = month < 0 ? 8760 : days[month] * 24;
  const avg = (a: Float64Array) => {
    const out = new Array(24).fill(0);
    for (let h = start; h < start + len; h++) out[h % 24] += a[h];
    return out.map((v) => v / (len / 24));
  };
  const solar = avg(d.solarToLoad.map((v, i) => v + d.charge[i] + d.curtailed[i]));
  const direct = avg(d.solarToLoad);
  const dis = avg(d.discharge);
  const fossil = avg(d.fossil);
  const soc = avg(d.soc);

  const svg = $('sim-day') as unknown as SVGSVGElement;
  const W = 800, L = 44, B = 222, T = 12;
  const maxY = Math.max(...solar, ...direct.map((v, i) => v + dis[i] + fossil[i]), 0.001) * 1.1;
  const X = (h: number) => L + (h / 24) * (W - L);
  const Y = (v: number) => B - (v / maxY) * (B - T);
  svg.replaceChildren();
  const el = (tag: string, a: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    svg.append(e);
    return e;
  };
  for (const f of [0.25, 0.5, 0.75, 1]) {
    const v = (maxY / 1.1) * f;
    el('line', { x1: L, x2: W, y1: Y(v), y2: Y(v), stroke: '#1a212d' });
    el('text', { x: L - 6, y: Y(v) + 4, fill: '#8792a5', 'font-size': 11, 'text-anchor': 'end' }, fmt(v, v < 10 ? 1 : 0));
  }
  const band = (lo: number[], hi: number[], color: string) => {
    let p = '';
    for (let h = 0; h < 24; h++) p += `${h ? 'L' : 'M'}${X(h)} ${Y(hi[h])}L${X(h + 1)} ${Y(hi[h])}`;
    for (let h = 23; h >= 0; h--) p += `L${X(h + 1)} ${Y(lo[h])}L${X(h)} ${Y(lo[h])}`;
    el('path', { d: p + 'Z', fill: color });
  };
  const zero = new Array(24).fill(0);
  const s1 = direct;
  const s2 = direct.map((v, i) => v + dis[i]);
  const s3 = s2.map((v, i) => v + fossil[i]);
  band(zero, s1, COLORS.solar);
  band(s1, s2, COLORS.battery);
  band(s2, s3, COLORS.fossil);
  el('path', { d: 'M' + solar.map((v, h) => `${X(h + 0.5)} ${Y(v)}`).join('L'), fill: 'none', stroke: COLORS.solar, 'stroke-width': 1.5, 'stroke-dasharray': '4 4' });
  el('line', { x1: L, x2: W, y1: B, y2: B, stroke: '#3a4558' });
  for (const h of [0, 4, 8, 12, 16, 20, 24]) el('text', { x: X(h), y: B + 18, fill: '#8792a5', 'font-size': 11, 'text-anchor': 'middle' }, `${String(h).padStart(2, '0')}:00`);
  el('text', { x: 0, y: T + 2, fill: '#8792a5', 'font-size': 11 }, 'MW');

  const socSvg = $('sim-soc') as unknown as SVGSVGElement;
  socSvg.replaceChildren();
  const sh = 70;
  const smax = Math.max(d.socMax, 1e-9);
  const SY = (v: number) => sh - 4 - (v / smax) * (sh - 10);
  const r1 = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ x: L, y: SY(d.socMax), width: W - L, height: SY(d.socMin) - SY(d.socMax), fill: COLORS.battery, 'fill-opacity': 0.12 })) r1.setAttribute(k, String(v));
  const p1 = document.createElementNS(SVG, 'path');
  p1.setAttribute('d', 'M' + soc.map((v, h) => `${X(h + 0.5)} ${SY(v)}`).join('L'));
  p1.setAttribute('fill', 'none');
  p1.setAttribute('stroke', COLORS.battery);
  p1.setAttribute('stroke-width', '2');
  socSvg.append(r1, p1);
}
