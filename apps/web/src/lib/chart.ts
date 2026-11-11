// Chart maths for the hand-rolled SVG charts (no chart library).

export interface Pt {
  x: number;
  y: number;
}

/** Round a maximum up to 1 / 2 / 2.5 / 5 / 10 times a power of ten so axis ticks are readable. */
export function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const f = v / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * base;
}

export function niceTicks(max: number, count = 4): number[] {
  const top = niceMax(max);
  return Array.from({ length: count + 1 }, (_, i) => (top * i) / count);
}

export function linearScale(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) / span) * (r1 - r0);
}

export interface Box {
  width: number;
  height: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
}

export function plotArea(b: Box): { x0: number; x1: number; y0: number; y1: number } {
  return { x0: b.padL, x1: b.width - b.padR, y0: b.height - b.padB, y1: b.padT };
}

/** x positions of n bars/points evenly spread over the plot (centred in n equal slots). */
export function slotX(n: number, b: Box): (i: number) => number {
  const { x0, x1 } = plotArea(b);
  const w = (x1 - x0) / Math.max(1, n);
  return (i) => x0 + w * (i + 0.5);
}

export function barGeometry(values: number[], b: Box, max?: number): { x: number; y: number; w: number; h: number; value: number }[] {
  const { x0, x1, y0, y1 } = plotArea(b);
  const top = max ?? niceMax(Math.max(0, ...values));
  const y = linearScale(0, top, y0, y1);
  const slot = (x1 - x0) / Math.max(1, values.length);
  const w = Math.min(48, slot * 0.7);
  const cx = slotX(values.length, b);
  return values.map((v, i) => {
    const yy = y(Math.max(0, v));
    return { x: cx(i) - w / 2, y: yy, w, h: Math.max(v > 0 ? 1 : 0, y0 - yy), value: v };
  });
}

export function linePoints(values: number[], b: Box, max?: number): Pt[] {
  const { y0, y1 } = plotArea(b);
  const top = max ?? niceMax(Math.max(0, ...values));
  const y = linearScale(0, top, y0, y1);
  const cx = slotX(values.length, b);
  return values.map((v, i) => ({ x: cx(i), y: y(v) }));
}

const r = (n: number): string => (Math.round(n * 100) / 100).toString();

export function linePath(pts: Pt[]): string {
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${r(p.x)} ${r(p.y)}`).join(" ");
}

export function areaPath(pts: Pt[], baseY: number): string {
  if (pts.length === 0) return "";
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  return `${linePath(pts)} L${r(last.x)} ${r(baseY)} L${r(first.x)} ${r(baseY)} Z`;
}

/** Share of `part` in `total` in [0,1] (0 when total is 0). */
export const share = (part: number, total: number): number => (total > 0 ? Math.min(1, Math.max(0, part / total)) : 0);

/** Pick at most `max` evenly spaced indices (always includes first and last) for x-axis labels. */
export function labelIndices(n: number, max: number): number[] {
  if (n <= 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>([0, n - 1]);
  const step = (n - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) out.add(Math.round(i * step));
  return [...out].sort((a, b) => a - b);
}

/** Stack `values` (>= 0) on top of each other for one bar: returns y/height per segment given a value->y scale and the baseline. */
export function stackSegments(values: number[], yOf: (v: number) => number, baseY: number): { y: number; h: number; from: number; to: number }[] {
  let acc = 0;
  return values.map((v) => {
    const from = acc;
    acc += Math.max(0, v);
    const yTop = yOf(acc);
    const yBottom = from === 0 ? baseY : yOf(from);
    return { y: yTop, h: Math.max(0, yBottom - yTop), from, to: acc };
  });
}
