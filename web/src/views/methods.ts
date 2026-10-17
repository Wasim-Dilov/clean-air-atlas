/** Methodology page, generated from the sourced files in data/static/ so it cannot drift from them. */

import presetsJson from '../../../data/static/presets.json';
import who from '../../../data/static/who_guidelines.json';
import conv from '../../../data/static/unit_conversions.json';
import { damageData, factorsData, fx, gensetFactors, lbPerHpHrToGPerKWh } from '../sim/factors';

type Cell = string | number | null | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function link(text: string, href: string): HTMLAnchorElement {
  const a = el('a', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function table(head: string[], rows: Cell[][], caption?: string): HTMLElement {
  const wrap = el('div', undefined, 'table-wrap');
  const t = el('table');
  if (caption) t.append(el('caption', caption));
  const tr = el('tr');
  head.forEach((h) => tr.append(el('th', h)));
  const thead = el('thead');
  thead.append(tr);
  const tbody = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    r.forEach((c, i) => {
      const td = el('td', c === null || c === undefined ? '–' : typeof c === 'number' ? c.toLocaleString('en-GB', { maximumFractionDigits: 3 }) : c);
      if (typeof c === 'number' && i > 0) td.className = 'num';
      row.append(td);
    });
    tbody.append(row);
  }
  t.append(thead, tbody);
  wrap.append(t);
  return wrap;
}

const cap = (t: string | undefined) => (t ? t[0].toUpperCase() + t.slice(1) : '');

function section(title: string, ...children: (Node | string)[]): HTMLElement {
  const s = el('section', undefined, 'method-section');
  s.append(el('h2', title), ...children.map((c) => (typeof c === 'string' ? el('p', c) : c)));
  return s;
}

export function renderMethods(root: HTMLElement): void {
  if (root.dataset.rendered) return;
  root.dataset.rendered = '1';
  const src = (factorsData as unknown as { sources: Record<string, { title: string; url: string; range?: string }> }).sources;
  const presets = presetsJson as unknown as {
    battery_defaults: { round_trip: number; usable_dod: number; sources: { parameter: string; text: string; url: string }[] };
    presets: Record<string, { label: string; sources: { text: string; url?: string }[]; example_note: string }>;
  };

  const intro = el('div', undefined, 'method-intro');
  intro.append(
    el('h1', 'How the numbers are worked out'),
    el('p', 'Everything on this site is an estimate built from published sources. This page lists each input with its source, year and units. It is generated from the same files the app uses.'),
  );

  const chain = section(
    'The simulator in three steps',
    '1. Fossil power displaced (MWh a year). An hourly dispatch over a typical year: solar serves the load first, surplus charges the battery, the battery discharges into the evening and night, and fossil power covers the rest. The battery never charges from fossil power and stays inside its usable charge window.',
    '2. Emissions avoided (tonnes a year of NOx, SO2 and PM2.5): displaced MWh times an emission factor in kg per MWh of electricity, as a low, central and high range.',
    '3. Damage avoided (euros a year): tonnes times a damage cost per tonne, again as a range. Outside Europe there are no official damage costs, so the euro figure is a rough transfer from European values. Read the tonnes first.',
    'Gains are small where the grid is already clean.',
  );

  // Emission factors
  const powerRows = factorsData.power_plants.map((r) => [r.fuel, r.pollutant, r.value, r.low, r.high, r.unit, (r as unknown as { table: string }).table]);
  const effRows = factorsData.plant_efficiency.map((e) => [e.fuel, e.central * 100, e.low * 100, e.high * 100]);
  const g = gensetFactors();
  const gensetRows = factorsData.gensets.map((r) => [
    (r as unknown as { class: string }).class, r.pollutant, r.value, r.unit,
    r.unit.startsWith('lb/hp-hr') ? Number(lbPerHpHrToGPerKWh(r.value).toFixed(3)) : r.value, (r as unknown as { table: string }).table,
  ]);
  const mapping = Object.entries(factorsData.ember_fuel_mapping).map(([fuel, m]) => [fuel, m.note]);
  const factorsSection = section(
    'Emission factors',
    el('p', `Power plants: ${src.emep2023.title}. ${cap(src.emep2023.range)}.`),
    table(['Fuel', 'Pollutant', 'Value', 'Low', 'High', 'Units', 'Table'], powerRows),
    el('p', `Per MWh of electricity = factor (g/GJ) × 3.6 GJ/MWh ÷ efficiency. Efficiency: ${src.ecofys2018.title} (${src.ecofys2018.range ?? ''}). Low results use the low factor and the high efficiency; high results the reverse.`),
    table(['Fuel', 'Central %', 'Low %', 'High %'], effRows, 'Fleet efficiency, gross output over fuel input at net calorific value'),
    table(['Ember source', 'How it is counted'], mapping),
    el('p', `Diesel generators: ${src.ap42_3_3.title}; range also spans ${src.wb2014.title}. ${(factorsData as unknown as { genset_ranges: { note: string } }).genset_ranges.note}`),
    table(['Class', 'Pollutant', 'Published', 'Published units', 'kg/MWh', 'Table'], gensetRows),
    table(['Pollutant', 'Low kg/MWh', 'Central', 'High'], (['NOx', 'SO2', 'PM2.5'] as const).map((p) => [p, Number(g[p].low.toFixed(3)), Number(g[p].central.toFixed(3)), Number(g[p].high.toFixed(3))]), 'Generator factors as used'),
  );
  const srcList = el('ul', undefined, 'plain');
  for (const s of Object.values(src)) {
    const li = el('li');
    li.append(link(s.title, s.url));
    srcList.append(li);
  }
  factorsSection.append(srcList);

  // Damage costs
  const eeaAvg = damageData.rows.filter((r) => r.iso3 === 'EEA_AVG');
  const defra = damageData.rows.filter((r) => r.currency === 'GBP');
  const eeaCountries = new Set(damageData.rows.filter((r) => r.source === 'eea2024' && r.iso3 !== 'EEA_AVG').map((r) => r.iso3));
  const dSrc = damageData.sources;
  const damage = section(
    'Damage costs',
    el('p', `Europe: ${dSrc.eea2024.title}. Low uses the value of a life year (VOLY), high the value of a statistical life (VSL). The EEA publishes no central value, so the app uses VOLY as central and says so. EUR, 2021 prices. Country values for ${eeaCountries.size} countries.`),
    table(['Pollutant', 'Low (VOLY) €/t', 'High (VSL) €/t', 'Price year'], eeaAvg.map((r) => [r.pollutant, r.low, r.high, r.price_year]), 'EEA38+UK average, used as a rough transfer outside Europe'),
    el('p', `United Kingdom: ${dSrc.defra2025.title}. GBP, 2025 prices, converted to euros at ${fx.gbp_per_eur} GBP per EUR (ECB reference rate, ${fx.date}). Conversion changes the currency only, not the price year.`),
    table(['Pollutant', 'Low £/t', 'Central £/t', 'High £/t', 'Price year'], defra.map((r) => [r.pollutant, r.low, r.central, r.high, r.price_year]), 'Defra national average damage costs'),
  );
  const dl = el('ul', undefined, 'plain');
  for (const s of Object.values(dSrc)) {
    const li = el('li');
    li.append(link(s.title, s.url));
    dl.append(li);
  }
  damage.append(dl);

  // Solar, storage, presets
  const storageList = el('ul', undefined, 'plain');
  for (const b of presets.battery_defaults.sources) {
    const li = el('li', `${b.parameter}: ${b.text} `);
    li.append(link('source', b.url));
    storageList.append(li);
  }
  const presetList = el('div');
  for (const p of Object.values(presets.presets)) {
    presetList.append(el('h3', p.label));
    const ul = el('ul', undefined, 'plain');
    for (const s of p.sources) {
      const li = el('li', `${s.text} `);
      if (s.url) li.append(link('source', s.url));
      ul.append(li);
    }
    ul.append(el('li', p.example_note));
    presetList.append(ul);
  }
  const solar = section(
    'Solar, storage and presets',
    el('p', 'Solar output: PVGIS 5.3 (EU Joint Research Centre), hourly output of a fixed 1 kWp system for 2023, optimal tilt where PVGIS allows it, 14% system loss. Preset sites use a full hourly year; other countries use a typical day for each month at one point inside the country, which is a rough national profile. PVGIS © European Communities, 2001-2026.'),
    el('p', `Battery defaults: round-trip efficiency ${Math.round(presets.battery_defaults.round_trip * 100)}%, usable depth of discharge ${Math.round(presets.battery_defaults.usable_dod * 100)}%. Both are inputs you can change.`),
    storageList,
    presetList,
  );

  // Air data
  const day = who.pollutants;
  const air = section(
    'Air quality data',
    el('p', `Station colours use WHO 2021 24-hour levels: PM2.5 guideline ${day.pm25['24h'].guideline} µg/m³ and interim targets ${Object.values(day.pm25['24h'].interim_targets).join(', ')}; NO2 guideline ${day.no2['24h'].guideline} µg/m³ and interim targets ${Object.values(day.no2['24h'].interim_targets).join(', ')}. ${who.notes}`),
    el('p', `NO2 reported in ppm is converted at ${conv.no2_ppm_to_ugm3.value} µg/m³ per ppm (${conv.no2_ppm_to_ugm3.conditions}; ${conv.no2_ppm_to_ugm3.source})`),
    el('p', `Model NO2 is approximate. CAMS has no surface NO2 field, so the map uses the mass mixing ratio q (kg/kg) on the lowest model level and multiplies it by dry-air density from surface pressure p and 2 m temperature T: µg/m³ = q × p / (R_d × T) × 10^9, with R_d = ${conv.dry_air_gas_constant.value} ${conv.dry_air_gas_constant.units} (${conv.dry_air_gas_constant.source})`),
    el('p', 'Stations: OpenAQ and its data providers, latest hourly values, filtered for plausible values and freshness (6 hours). Model: CAMS global atmospheric composition forecasts, surface PM2.5 and lowest-model-level NO2, regridded to Web Mercator; contains modified Copernicus Atmosphere Monitoring Service information 2026, and neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains. Wind: NOAA NCEP GFS 10 m wind, 1° grid.'),
  );

  const limits = section(
    'Known limits',
    el('p', 'Bioenergy is not counted in grid averages (no sourced efficiency), so gains are understated where it is a large share.'),
    el('p', 'Plant efficiencies are fleet averages on a gross-output basis, which slightly understates emissions per net MWh.'),
    el('p', 'Named power plants need the Global Energy Monitor coal plant tracker, which is a manual download behind a form; until it is added, the plant mode uses a generic plant of the chosen fuel.'),
    el('p', 'Emission and damage ranges compound: the low result uses every low input, the high result every high input.'),
  );

  root.replaceChildren(intro, chain, factorsSection, damage, solar, air, limits);
}
