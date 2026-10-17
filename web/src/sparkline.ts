export interface Spark {
  d: string; // SVG path; a gap in the data starts a new sub-path
  last: { x: number; y: number } | null;
  y: (v: number) => number;
  count: number;
}

export function sparkPath(values: (number | null)[], width: number, height: number, floorMax = 0, pad = 4): Spark {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const max = Math.max(floorMax, ...present, 1) * 1.1;
  const n = Math.max(values.length - 1, 1);
  const x = (i: number) => pad / 2 + (i / n) * (width - pad);
  const y = (v: number) => height - pad - (v / max) * (height - 2 * pad);
  let d = '';
  let pen = false;
  let last: Spark['last'] = null;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
    last = { x: x(i), y: y(v) };
  });
  return { d, last, y, count: present.length };
}
