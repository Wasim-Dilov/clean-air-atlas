import type { Map as MapLibreMap } from 'maplibre-gl';

/** Scaling written by pipeline/gfs.py next to wind.png (R = U, G = V, 0..255). */
export interface WindMeta {
  source: string;
  cycle: string;
  step_h: number;
  valid: string;
  width: number;
  height: number;
  lat0: number;
  dlat: number;
  lon0: number;
  dlon: number;
  u: { min: number; max: number };
  v: { min: number; max: number };
  max_speed: number;
}

export class WindField {
  private readonly u: Float32Array;
  private readonly v: Float32Array;
  private readonly ok: Uint8Array;

  constructor(readonly meta: WindMeta, rgba: Uint8ClampedArray | Uint8Array) {
    const n = meta.width * meta.height;
    if (rgba.length !== n * 4) throw new Error('wind image size does not match its metadata');
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.ok = new Uint8Array(n);
    const ur = meta.u.max - meta.u.min;
    const vr = meta.v.max - meta.v.min;
    for (let i = 0; i < n; i++) {
      this.u[i] = meta.u.min + (rgba[i * 4] / 255) * ur;
      this.v[i] = meta.v.min + (rgba[i * 4 + 1] / 255) * vr;
      this.ok[i] = rgba[i * 4 + 3] > 0 ? 1 : 0;
    }
  }

  /** Bilinear U, V in m/s at a point, or null where there is no data. */
  sample(lon: number, lat: number): [number, number] | null {
    const { width: w, height: h, lat0, dlat, lon0, dlon } = this.meta;
    const fy = (lat0 - lat) / dlat;
    if (fy < 0 || fy > h - 1) return null;
    const fx = ((((lon - lon0) % 360) + 360) % 360) / dlon;
    const x0 = Math.floor(fx) % w;
    const x1 = (x0 + 1) % w;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, h - 1);
    const tx = fx - Math.floor(fx);
    const ty = fy - y0;
    const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
    if (!(this.ok[i00] & this.ok[i10] & this.ok[i01] & this.ok[i11])) return null;
    const lerp = (a: Float32Array) =>
      (a[i00] * (1 - tx) + a[i10] * tx) * (1 - ty) + (a[i01] * (1 - tx) + a[i11] * tx) * ty;
    return [lerp(this.u), lerp(this.v)];
  }
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Speed and the direction the wind blows from (meteorological convention). */
export function speedAndFrom(u: number, v: number): { speed: number; from: string; degrees: number } {
  const speed = Math.hypot(u, v);
  const degrees = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
  return { speed, from: COMPASS[Math.round(degrees / 45) % 8], degrees };
}

/** True when a point faces the viewer on the globe (with a margin before the horizon). */
export function facesViewer(lon: number, lat: number, centerLon: number, centerLat: number, margin = 0.08): boolean {
  const r = Math.PI / 180;
  const c = Math.sin(lat * r) * Math.sin(centerLat * r) + Math.cos(lat * r) * Math.cos(centerLat * r) * Math.cos((lon - centerLon) * r);
  return c > margin;
}

export async function loadWind(base: string): Promise<WindField> {
  const meta = (await (await fetch(`${base}wind/wind.json`, { cache: 'no-cache' })).json()) as WindMeta;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = `${base}wind/wind.png?v=${encodeURIComponent(meta.valid)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = meta.width;
  canvas.height = meta.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return new WindField(meta, ctx.getImageData(0, 0, meta.width, meta.height).data);
}

interface Particle {
  lon: number;
  lat: number;
  age: number;
  life: number;
  x: number;
  y: number;
  drawn: boolean;
}

/** Animated wind particles drawn on a canvas over the map. */
export class WindLayer {
  private particles: Particle[] = [];
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private moving = false;
  private enabled = true;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private readonly map: MapLibreMap, private readonly field: WindField, private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    map.on('resize', () => this.reset());
    map.on('movestart', () => {
      this.moving = true;
      this.clear();
    });
    map.on('moveend', () => {
      this.moving = false;
      this.reset();
    });
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    this.reduced.addEventListener('change', () => this.reset());
    this.reset();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.canvas.hidden = !on;
    if (on) this.reset();
    else this.stop();
  }

  private size(): { w: number; h: number } {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  private clear(): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private reset(): void {
    this.stop();
    if (!this.enabled) return;
    const { w, h } = this.size();
    this.clear();
    const target = Math.round(Math.min(5000, Math.max(600, (w * h) / (w < 760 ? 450 : 250))));
    this.particles = Array.from({ length: target }, () => this.spawn());
    if (this.reduced.matches) this.drawStill();
    else this.start();
  }

  private spawn(p?: Particle): Particle {
    const c = this.map.getCenter();
    const b = this.map.getBounds();
    const zoomedOut = this.map.getZoom() < 3;
    for (let tries = 0; tries < 30; tries++) {
      let lon: number, lat: number;
      if (zoomedOut) {
        lon = Math.random() * 360 - 180;
        lat = (Math.asin(2 * Math.random() - 1) * 180) / Math.PI;
      } else {
        lon = b.getWest() + Math.random() * (b.getEast() - b.getWest());
        lat = b.getSouth() + Math.random() * (b.getNorth() - b.getSouth());
      }
      if (!facesViewer(lon, lat, c.lng, c.lat) || !this.field.sample(lon, lat)) continue;
      const q = p ?? ({} as Particle);
      Object.assign(q, { lon, lat, age: 0, life: 40 + Math.floor(Math.random() * 60), drawn: false });
      return q;
    }
    return Object.assign(p ?? ({} as Particle), { lon: c.lng, lat: c.lat, age: 999, life: 0, drawn: false });
  }

  start(): void {
    if (this.raf || !this.enabled || this.reduced.matches || document.hidden) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      if (!this.moving) this.step();
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Degrees moved per frame for 1 m/s, so on-screen speed looks similar at every zoom. */
  private k(): number {
    return 0.024 / Math.pow(2, this.map.getZoom());
  }

  private advance(p: Particle, k: number): boolean {
    const uv = this.field.sample(p.lon, p.lat);
    if (!uv) return false;
    const coslat = Math.max(Math.cos((p.lat * Math.PI) / 180), 0.2);
    p.lon += (uv[0] * k) / coslat;
    p.lat += uv[1] * k;
    if (p.lon > 180) p.lon -= 360;
    if (p.lon < -180) p.lon += 360;
    return Math.abs(p.lat) < 85;
  }

  private step(): void {
    const { w, h } = this.size();
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.94)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    const c = this.map.getCenter();
    const k = this.k();
    const slow = new Path2D();
    const fast = new Path2D();
    for (const p of this.particles) {
      if (p.age++ > p.life) {
        this.spawn(p);
        continue;
      }
      const uv = this.field.sample(p.lon, p.lat);
      if (!uv || !this.advance(p, k) || !facesViewer(p.lon, p.lat, c.lng, c.lat)) {
        this.spawn(p);
        continue;
      }
      const pt = this.map.project([p.lon, p.lat]);
      if (pt.x < -20 || pt.y < -20 || pt.x > w + 20 || pt.y > h + 20) {
        this.spawn(p);
        continue;
      }
      if (p.drawn && Math.abs(pt.x - p.x) < 40 && Math.abs(pt.y - p.y) < 40) {
        const path = Math.hypot(uv[0], uv[1]) > 8 ? fast : slow;
        path.moveTo(p.x, p.y);
        path.lineTo(pt.x, pt.y);
      }
      p.x = pt.x;
      p.y = pt.y;
      p.drawn = true;
    }
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = 'rgba(223, 230, 239, 0.45)';
    ctx.stroke(slow);
    ctx.strokeStyle = 'rgba(237, 241, 247, 0.75)';
    ctx.stroke(fast);
  }

  /** Reduced motion: short still streamlines instead of animation. */
  private drawStill(): void {
    const { w, h } = this.size();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    const c = this.map.getCenter();
    const k = this.k() * 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(223, 230, 239, 0.45)';
    const path = new Path2D();
    for (const p of this.particles.slice(0, 1200)) {
      let start = true;
      for (let i = 0; i < 12; i++) {
        if (!facesViewer(p.lon, p.lat, c.lng, c.lat)) break;
        const pt = this.map.project([p.lon, p.lat]);
        if (start) path.moveTo(pt.x, pt.y);
        else path.lineTo(pt.x, pt.y);
        start = false;
        if (!this.advance(p, k)) break;
      }
    }
    ctx.stroke(path);
  }
}
