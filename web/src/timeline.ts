/** Time slider model: hourly slots over 72 hours of measurements plus the model forecast. */

export interface StationManifest {
  parameter: string;
  units: string;
  latest: string;
  coords: string;
  series: string; // path template with {shard}
  shards: number;
  frames: { t: string; file: string; count: number }[];
}

export interface ModelManifest {
  parameter: string;
  note?: string;
  bounds: [[number, number], [number, number], [number, number], [number, number]];
  latest_run: string | null;
  frames: { valid: string; run: string; lead: number; file: string }[];
}

export interface Slot {
  t: number; // epoch ms, on the hour
  measured: boolean; // at or before the latest station hour
  stationFile: string | null;
  modelFile: string | null;
}

const HOUR = 3_600_000;

/** Nearest model frame within maxGap (frames are 3-hourly, so 90 minutes covers every hour). */
export function nearestModel(frames: ModelManifest['frames'], t: number, maxGap = 1.5 * HOUR): string | null {
  let best: string | null = null;
  let bestGap = Infinity;
  for (const f of frames) {
    const gap = Math.abs(Date.parse(f.valid) - t);
    if (gap < bestGap || (gap === bestGap && best !== null && f.file > best)) {
      best = f.file;
      bestGap = gap;
    }
  }
  return bestGap <= maxGap ? best : null;
}

export function buildSlots(stations: StationManifest | null, model: ModelManifest | null): Slot[] {
  const stationByT = new Map((stations?.frames ?? []).map((f) => [Date.parse(f.t), f.file]));
  const modelTimes = (model?.frames ?? []).map((f) => Date.parse(f.valid));
  const latest = stations ? Date.parse(stations.latest) : -Infinity;
  const all = [...stationByT.keys(), ...modelTimes].filter(Number.isFinite);
  if (all.length === 0) return [];
  const start = Math.min(...all);
  const end = Math.max(...all);
  const slots: Slot[] = [];
  for (let t = Math.floor(start / HOUR) * HOUR; t <= end; t += HOUR) {
    const stationFile = stationByT.get(t) ?? null;
    const modelFile = model ? nearestModel(model.frames, t) : null;
    if (!stationFile && !modelFile) continue;
    slots.push({ t, measured: t <= latest, stationFile, modelFile });
  }
  return slots;
}

/** Start on the newest measured hour, or the first slot if there are no measurements. */
export function defaultSlot(slots: Slot[]): number {
  for (let i = slots.length - 1; i >= 0; i--) if (slots[i].stationFile) return i;
  return 0;
}

export function formatSlot(t: number): string {
  const d = new Date(t);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${day}, ${time} UTC`;
}

export function seriesShard(id: number, shards: number): number {
  return ((id % shards) + shards) % shards;
}
