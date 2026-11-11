import type { Word } from "@klipz/shared";

export const MIN_CLIP_SEC = 1;
export const MAX_CLIP_SEC = 180;

/** Sorted, de-duplicated word start/end times: the places a cut sounds natural. */
export function wordBoundaries(words: Word[]): number[] {
  const set = new Set<number>();
  for (const w of words) {
    set.add(Math.round(w.s * 1000) / 1000);
    set.add(Math.round(w.e * 1000) / 1000);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Snap `t` to the nearest word boundary within `threshold` seconds.
 * Returns `t` unchanged when nothing is close enough or `disabled` (Alt held).
 */
export function snapToBoundary(t: number, boundaries: number[], threshold = 0.25, disabled = false): number {
  if (disabled || boundaries.length === 0) return t;
  // binary search for the insertion point
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boundaries[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  const a = boundaries[lo - 1];
  const b = boundaries[lo];
  let best: number | undefined;
  if (a !== undefined && (b === undefined || t - a <= b - t)) best = a;
  else best = b;
  return best !== undefined && Math.abs(best - t) <= threshold ? best : t;
}

export interface RangeLimits {
  duration: number | null;
  min?: number;
  max?: number;
}

/**
 * Move one edge of [start, end] to `t`, keeping the length within limits and
 * inside the source. The other edge stays put.
 */
export function moveEdge(start: number, end: number, edge: "start" | "end", t: number, limits: RangeLimits): [number, number] {
  const min = limits.min ?? MIN_CLIP_SEC;
  const max = limits.max ?? MAX_CLIP_SEC;
  const dur = limits.duration != null && limits.duration > 0 ? limits.duration : Number.POSITIVE_INFINITY;
  if (edge === "start") {
    const s = Math.min(Math.max(t, 0, end - max), end - min);
    return [round(s), end];
  }
  const e = Math.max(Math.min(t, dur, start + max), start + min);
  return [start, round(e)];
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

/** Keyboard nudge: arrow = 0.1 s, Shift = 1 s. */
export const nudgeStep = (shift: boolean): number => (shift ? 1 : 0.1);

export interface TrimWindow {
  lo: number;
  hi: number;
}

export const initialWindow = (start: number, end: number, duration: number | null, pad = 15): TrimWindow => ({
  lo: Math.max(0, start - pad),
  hi: duration ? Math.min(duration, end + pad) : end + pad,
});

/**
 * Let the trim window follow the handles: when a handle sits at (or beyond) the window edge the window
 * grows by `pad` seconds beyond it, never past 0 or the source duration. It never shrinks, so the track does
 * not rescale under the pointer. Call it when a drag ends, after a keyboard nudge and for outside changes.
 */
export function followWindow(win: TrimWindow, start: number, end: number, duration: number | null, pad = 15, edgeEps = 0.3): TrimWindow {
  let { lo, hi } = win;
  if (start <= lo + edgeEps) lo = Math.max(0, Math.min(lo, start - pad));
  if (end >= hi - edgeEps) hi = duration ? Math.min(duration, Math.max(hi, end + pad)) : Math.max(hi, end + pad);
  // a handle can also jump far outside (e.g. the server clamped the range elsewhere)
  if (start < lo) lo = Math.max(0, start - pad);
  if (end > hi) hi = duration ? Math.min(duration, end + pad) : end + pad;
  return lo === win.lo && hi === win.hi ? win : { lo, hi };
}
