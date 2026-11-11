// Pure helpers for the timeline view: seconds <-> pixels, zoom and ruler ticks.

export const MIN_PPS = 4; // pixels per second
export const MAX_PPS = 600;

export const clampPps = (pps: number): number => Math.min(MAX_PPS, Math.max(MIN_PPS, pps));

export const timeToX = (t: number, pps: number): number => t * pps;
export const xToTime = (x: number, pps: number): number => x / pps;

/** Pixels per second that fit `duration` into `width` px (clamped). */
export function fitPps(duration: number, width: number): number {
  if (!(duration > 0) || !(width > 0)) return 60;
  return clampPps(width / duration);
}

/**
 * New scroll offset after zooming from `oldPps` to `newPps` such that the time
 * under `anchorX` (viewport px) stays under the cursor.
 */
export function scrollAfterZoom(scrollLeft: number, anchorX: number, oldPps: number, newPps: number): number {
  const tAtAnchor = (scrollLeft + anchorX) / oldPps;
  return Math.max(0, tAtAnchor * newPps - anchorX);
}

const NICE_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** Smallest "nice" step (seconds) whose ticks are at least `minPx` apart. */
export function tickStep(pps: number, minPx = 70): number {
  return NICE_STEPS.find((s) => s * pps >= minPx) ?? NICE_STEPS[NICE_STEPS.length - 1]!;
}

export interface Tick {
  t: number;
  x: number;
  major: boolean;
  label: string | null;
}

export function formatRuler(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, "0")}`;
  return `${m}:${String(Math.round(s)).padStart(2, "0")}`;
}

/** Ticks inside [fromT, toT]; every tick is minor-or-major with a label on majors. */
export function rulerTicks(pps: number, fromT: number, toT: number): Tick[] {
  const step = tickStep(pps);
  const minor = step / (step === 0.05 ? 5 : step === 0.1 || step === 5 || step === 10 || step === 1 ? 5 : 4);
  const out: Tick[] = [];
  const first = Math.floor(Math.max(0, fromT) / minor);
  const last = Math.ceil(toT / minor);
  for (let i = first; i <= last; i++) {
    const t = i * minor;
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    out.push({ t, x: timeToX(t, pps), major, label: major ? formatRuler(t, step) : null });
  }
  return out;
}

/** Indices of items overlapping the visible time window (for virtualised rows). */
export function visibleRange<T extends { start: number; end: number }>(items: T[], fromT: number, toT: number): T[] {
  return items.filter((it) => it.end >= fromT && it.start <= toT);
}

export const frameToSec = (frame: number, fps = 30): number => frame / fps;
export const secToFrame = (t: number, fps = 30): number => Math.round(t * fps);

/** Clamp a frame to the playable range [0, durationInFrames-1]. */
export const clampFrame = (frame: number, durationInFrames: number): number => Math.min(Math.max(0, Math.round(frame)), Math.max(0, durationInFrames - 1));

/**
 * Items sorted by `start` that overlap [fromT, toT]. Binary search on the first
 * item that could be visible, then a short linear scan, so cost is O(log n + visible).
 * `maxLen` bounds how long an item can be (items starting earlier than from-maxLen cannot reach the window).
 */
export function sliceByStart<T extends { start: number; end: number }>(sorted: T[], fromT: number, toT: number, maxLen = 5): T[] {
  let lo = 0;
  let hi = sorted.length;
  const lower = fromT - maxLen;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.start < lower) lo = mid + 1;
    else hi = mid;
  }
  const out: T[] = [];
  for (let i = lo; i < sorted.length; i++) {
    const it = sorted[i]!;
    if (it.start > toT) break;
    if (it.end >= fromT) out.push(it);
  }
  return out;
}
