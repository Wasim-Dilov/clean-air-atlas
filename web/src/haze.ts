/**
 * Station zones: a soft coloured field smoothed from nearby stations, drawn on the map
 * as a world-sized Web Mercator image under the place labels.
 *
 * Each cell is the kernel-weighted mean of the stations around it (Gaussian weights).
 * Cells far from any station stay clear, so the map does not suggest values where
 * nothing is measured. It is a display aid, not a measurement of the area in between.
 */

import type { CanvasSource, Map as MapLibreMap } from 'maplibre-gl';
import { bandIndex } from './bands';

export const MAX_LAT = 85.0511287798066;
export const WORLD: [[number, number], [number, number], [number, number], [number, number]] = [
  [-180, MAX_LAT], [180, MAX_LAT], [180, -MAX_LAT], [-180, -MAX_LAT],
];

export interface HazePoint {
  lon: number;
  lat: number;
  v: number;
}

/** Pixel position of a point on a size × size Web Mercator world image. */
export function mercatorXY(lon: number, lat: number, size: number): [number, number] {
  const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
  const x = ((((lon + 180) % 360) + 360) % 360) / 360 * size;
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
  return [x, y];
}

/** Kernel sums: num = Σ w·v and den = Σ w, with Gaussian weights of the given sigma (pixels). */
export function splat(points: HazePoint[], size: number, sigma: number): { num: Float32Array; den: Float32Array } {
  const num = new Float32Array(size * size);
  const den = new Float32Array(size * size);
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

export interface HazeStyle {
  edges: readonly number[];
  ramp: readonly string[];
  alphas: readonly number[]; // one per band, 0..255
  minWeight: number; // below this summed weight a cell stays clear
  fullWeight: number; // at or above this the band alpha applies in full
}

const hexRGB = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** RGBA pixels: band colour of the weighted mean, fading out where stations are far away. */
export function colorizeHaze(num: Float32Array, den: Float32Array, style: HazeStyle, out?: Uint8ClampedArray): Uint8ClampedArray {
  const px = out ?? new Uint8ClampedArray(num.length * 4);
  const rgb = style.ramp.map(hexRGB);
  const span = style.fullWeight - style.minWeight;
  for (let i = 0; i < num.length; i++) {
    const d = den[i];
    const o = i * 4;
    if (d < style.minWeight) {
      px[o + 3] = 0;
      continue;
    }
    const b = bandIndex(num[i] / d, style.edges);
    const t = Math.min(1, (d - style.minWeight) / span);
    const fade = t * t * (3 - 2 * t);
    const [r, g, bl] = rgb[b];
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = bl;
    px[o + 3] = Math.round(style.alphas[b] * fade);
  }
  return px;
}

/** Map layer that draws the zones through a MapLibre canvas source. */
export class HazeLayer {
  readonly size: number;
  readonly sigma: number;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;

  constructor(private map: MapLibreMap, beforeId?: string) {
    // About 0.18° per pixel on desktop (0.35° on phones). Sigma is about 1.1° (roughly 120 km at the
    // equator, less towards the poles), so a lone station shades up to about 2 sigma around it.
    this.size = window.innerWidth < 760 ? 1024 : 2048;
    this.sigma = this.size / 320;
    this.canvas.width = this.canvas.height = this.size;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(this.size, this.size);
    map.addSource('haze', { type: 'canvas', canvas: this.canvas, coordinates: WORLD, animate: false } as never);
    map.addLayer(
      { id: 'haze', type: 'raster', source: 'haze', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } },
      beforeId,
    );
  }

  update(points: HazePoint[], style: Omit<HazeStyle, 'minWeight' | 'fullWeight'>): void {
    const { num, den } = splat(points, this.size, this.sigma);
    colorizeHaze(num, den, { ...style, minWeight: 0.1, fullWeight: 0.5 }, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
    const src = this.map.getSource('haze') as CanvasSource | undefined;
    if (!src) return;
    // A paused canvas source only re-reads its pixels while playing: play for a frame, then pause.
    src.play();
    this.map.triggerRepaint();
    requestAnimationFrame(() => requestAnimationFrame(() => src.pause()));
  }

  setVisible(on: boolean): void {
    this.map.setLayoutProperty('haze', 'visibility', on ? 'visible' : 'none');
  }
}
