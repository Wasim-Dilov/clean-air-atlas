/**
 * Station clouds: coloured areas smoothed from nearby stations, drawn on the map as a
 * world-sized Web Mercator image under the place labels.
 *
 * Each cell takes the kernel-weighted mean of the stations around it (Gaussian weights),
 * averaged in log space because concentrations are skewed: one very high station should
 * not tint a whole region of cleaner ones. Two kernels work together. A narrow one sets
 * the colour, so a cloud matches the stations inside it; a wide one fills the gaps between
 * stations and decides how far a cloud reaches. Cells far from any station stay clear, so
 * the map does not suggest values where nothing is measured. It is a display aid, not a
 * measurement of the area in between.
 */

import type { CanvasSource, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { bandIndex, RIM_COLOR } from './bands';
import { colourMask, contourLines, type Line } from './contour';

export const MAX_LAT = 85.0511287798066;
export const WORLD: [[number, number], [number, number], [number, number], [number, number]] = [
  [-180, MAX_LAT], [180, MAX_LAT], [180, -MAX_LAT], [-180, -MAX_LAT],
];

export interface HazePoint {
  lon: number;
  lat: number;
  v: number;
}

export interface Sums {
  num: Float32Array;
  den: Float32Array;
}

/** Pixel position of a point on a size × size Web Mercator world image. */
export function mercatorXY(lon: number, lat: number, size: number): [number, number] {
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const x = ((((lon + 180) % 360) + 360) % 360) / 360 * size;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
  return [x, y];
}

/** Longitude and latitude of a pixel position on a size × size Web Mercator world image. */
export function mercatorLonLat(x: number, y: number, size: number): [number, number] {
  const lon = (x / size) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / size))) * 180) / Math.PI;
  return [lon, lat];
}

/** Kernel sums: num = Σ w·v and den = Σ w, with Gaussian weights of the given sigma (pixels). */
export function splat(points: HazePoint[], size: number, sigma: number, out?: Sums): Sums {
  const num = out?.num.fill(0) ?? new Float32Array(size * size);
  const den = out?.den.fill(0) ?? new Float32Array(size * size);
  const r = Math.ceil(3 * sigma);
  const span = 2 * r + 1;
  const kernel = new Float32Array(span * span);
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) kernel[(dy + r) * span + (dx + r)] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
  for (const p of points) {
    if (!Number.isFinite(p.v) || Math.abs(p.lat) >= MAX_LAT) continue;
    const [x, y] = mercatorXY(p.lon, p.lat, size);
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    for (let dy = -r; dy <= r; dy++) {
      const yy = iy + dy;
      if (yy < 0 || yy >= size) continue;
      const row = yy * size;
      const krow = (dy + r) * span + r;
      for (let dx = -r; dx <= r; dx++) {
        const xx = (((ix + dx) % size) + size) % size; // wrap across the date line
        const w = kernel[krow + dx];
        num[row + xx] += w * p.v;
        den[row + xx] += w;
      }
    }
  }
  return { num, den };
}

/** Add `k` times the wide sums into the narrow ones, so the wide kernel only matters where the narrow one is thin. */
export function blendSums(near: Sums, wide: Sums, k: number): Sums {
  for (let i = 0; i < near.num.length; i++) {
    near.num[i] += k * wide.num[i];
    near.den[i] += k * wide.den[i];
  }
  return near;
}

export interface HazeStyle {
  edges: readonly number[]; // in the same units as num / den
  ramp: readonly string[];
  alphas: readonly number[]; // one per band, 0..255
  minWeight: number; // below this coverage weight a cell stays clear
  fullWeight: number; // at or above this the band alpha applies in full
  soft?: number; // half-width of the blend across each band edge, in edge units (0: hard edges)
}

export const hexRGB = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/**
 * RGBA pixels: band colour of the weighted mean num / den, fading out where the coverage
 * weight is low (far from stations). Coverage defaults to den.
 */
export function colorizeHaze(num: Float32Array, den: Float32Array, style: HazeStyle, out?: Uint8ClampedArray, cover: Float32Array = den): Uint8ClampedArray {
  const px = out ?? new Uint8ClampedArray(num.length * 4);
  const rgb = style.ramp.map(hexRGB);
  const span = style.fullWeight - style.minWeight;
  const soft = style.soft ?? 0;
  for (let i = 0; i < num.length; i++) {
    const c = cover[i];
    const o = i * 4;
    if (c < style.minWeight || den[i] <= 0) {
      px[o + 3] = 0;
      continue;
    }
    const m = num[i] / den[i];
    const b = bandIndex(m, style.edges);
    // Within `soft` of an edge, mix towards the neighbouring band (50/50 on the edge itself),
    // so the coarse grid shows smooth band edges instead of pixel steps when zoomed in.
    let other = b;
    let t = 0;
    if (soft > 0 && b < style.edges.length && style.edges[b] - m < soft) {
      other = b + 1;
      t = (soft - (style.edges[b] - m)) / (2 * soft);
    } else if (soft > 0 && b > 0 && m - style.edges[b - 1] < soft) {
      other = b - 1;
      t = (soft - (m - style.edges[b - 1])) / (2 * soft);
    }
    const ct = Math.min(1, (c - style.minWeight) / span);
    const fade = ct * ct * (3 - 2 * ct);
    const p = rgb[b];
    const q = rgb[other];
    px[o] = p[0] + (q[0] - p[0]) * t;
    px[o + 1] = p[1] + (q[1] - p[1]) * t;
    px[o + 2] = p[2] + (q[2] - p[2]) * t;
    px[o + 3] = Math.round((style.alphas[b] + (style.alphas[other] - style.alphas[b]) * t) * fade);
  }
  return px;
}

/**
 * Field whose zero line outlines the top band where its cloud is at least half drawn:
 * positive where the weighted mean is above `edge` (a positive value) and the coverage
 * weight reaches `weight`.
 */
export function topBandField(num: Float32Array, den: Float32Array, edge: number, weight: number, out?: Float32Array, cover: Float32Array = den): Float32Array {
  const f = out ?? new Float32Array(num.length);
  for (let i = 0; i < num.length; i++) {
    const d = den[i];
    f[i] = d <= 0 ? -1 : Math.min(cover[i] / weight - 1, num[i] / d / edge - 1);
  }
  return f;
}

/** Contour lines in world-image pixels, as GeoJSON in longitude and latitude. */
export function linesToGeoJSON(lines: Line[], size: number): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: lines.length
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines.map((l) => l.map(([x, y]) => mercatorLonLat(x, y, size))) } }]
      : [],
  };
}

/** Thin light outline drawn above a cloud layer, for areas in the near-black top band. */
export class RimLayer {
  constructor(private map: MapLibreMap, readonly id: string, beforeId?: string) {
    map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer(
      {
        id, type: 'line', source: id, layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': RIM_COLOR, 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1, 8, 1.5] },
      },
      beforeId,
    );
  }

  set(lines: Line[], size: number): void {
    (this.map.getSource(this.id) as GeoJSONSource | undefined)?.setData(linesToGeoJSON(lines, size) as never);
  }

  setVisible(on: boolean): void {
    this.map.setLayoutProperty(this.id, 'visibility', on ? 'visible' : 'none');
  }
}

// Cloud edges. A cloud fading out over the dark map passes through dark tones that look like the
// near-black top band, so the fade is short: a lone station's cloud is full out to about 1.5 wide
// sigma and gone by 2 (about 180 and 240 km at the equator, less towards the poles).
const MIN_WEIGHT = 0.14;
const FULL_WEIGHT = 0.3;
// How much the wide kernel counts towards the colour, relative to the narrow one.
const WIDE_SHARE = 0.03;
// Band edges blend over ±6 % of the value (in log space), which hides the grid's pixel steps.
const SOFT = 0.06;

/** Map layer that draws the clouds through a MapLibre canvas source, with an outline on the top band. */
export class HazeLayer {
  readonly size: number;
  readonly sigma: number;
  readonly sigmaNear: number;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private rim: RimLayer;
  private near: Sums;
  private wide: Sums;

  constructor(private map: MapLibreMap, beforeId?: string) {
    // About 0.18° per pixel on desktop (0.35° on phones). The wide sigma is about 1.1° (roughly
    // 120 km at the equator) and fills gaps between stations. The narrow one sets the colour, so
    // city hotspots and clean valleys keep their own band: 2 pixels, about 0.35° (40 km) on desktop
    // and 0.7° on phones. Any narrower and band edges follow the pixel grid when zoomed in.
    this.size = window.innerWidth < 760 ? 1024 : 2048;
    this.sigma = this.size / 320;
    this.sigmaNear = 2;
    const n = this.size * this.size;
    this.canvas.width = this.canvas.height = this.size;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(this.size, this.size);
    this.near = { num: new Float32Array(n), den: new Float32Array(n) };
    this.wide = { num: new Float32Array(n), den: new Float32Array(n) };
    map.addSource('haze', { type: 'canvas', canvas: this.canvas, coordinates: WORLD, animate: false } as never);
    map.addLayer(
      { id: 'haze', type: 'raster', source: 'haze', layout: { visibility: 'none' }, paint: { 'raster-opacity': 1, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } },
      beforeId,
    );
    this.rim = new RimLayer(map, 'haze-rim', beforeId);
  }

  update(points: HazePoint[], style: Omit<HazeStyle, 'minWeight' | 'fullWeight'>): void {
    const logPoints = points.map((p) => ({ lon: p.lon, lat: p.lat, v: Math.log1p(Math.max(p.v, 0)) }));
    const edges = style.edges.map(Math.log1p);
    splat(logPoints, this.size, this.sigma, this.wide);
    splat(logPoints, this.size, this.sigmaNear, this.near);
    const { num, den } = blendSums(this.near, this.wide, WIDE_SHARE);
    const cover = this.wide.den;
    colorizeHaze(num, den, { ...style, edges, minWeight: MIN_WEIGHT, fullWeight: FULL_WEIGHT, soft: SOFT }, this.image.data, cover);
    this.ctx.putImageData(this.image, 0, 0);
    // The wide sums are folded in by now, so their num buffer can hold the outline field.
    const field = topBandField(num, den, edges[edges.length - 1], (MIN_WEIGHT + FULL_WEIGHT) / 2, this.wide.num, cover);
    this.rim.set(contourLines(field, this.size, this.size), this.size);
    const src = this.map.getSource('haze') as CanvasSource | undefined;
    if (!src) return;
    // A paused canvas source only re-reads its pixels while playing: play for a frame, then pause.
    src.play();
    this.map.triggerRepaint();
    requestAnimationFrame(() => requestAnimationFrame(() => src.pause()));
  }

  setVisible(on: boolean): void {
    this.map.setLayoutProperty('haze', 'visibility', on ? 'visible' : 'none');
    this.rim.setVisible(on);
  }
}

/**
 * Outline of the top band in a coloured model frame (a world Web Mercator PNG whose top band
 * is drawn in `colour`), found by decoding the image and tracing that colour.
 */
export async function imageOutline(url: string, colour: string): Promise<{ lines: Line[]; size: number }> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { lines: contourLines(colourMask(data, width, height, hexRGB(colour)), width, height, 0.5), size: width };
}
