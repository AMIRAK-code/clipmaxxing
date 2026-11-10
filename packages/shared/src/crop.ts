import type { CropKey, CropSegment, CropTrack } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pane of the output frame showing a window of the source. */
export interface Pane {
  /** where it sits in the output frame (px) */
  dst: Rect;
  /** which part of the source it shows (source px) */
  src: Rect;
}

export interface FrameLayout {
  layout: CropSegment["layout"];
  panes: Pane[];
  /** letterbox draws a blurred, cover-scaled copy of the source behind the pane */
  blurredBackground: boolean;
}

export function segmentAt(track: CropTrack, t: number): CropSegment | null {
  for (const s of track.segments) if (t >= s.start && t < s.end) return s;
  // Past the end (or in a gap): hold the nearest segment so we never flash to centre.
  let best: CropSegment | null = null;
  let bestD = Infinity;
  for (const s of track.segments) {
    const d = t < s.start ? s.start - t : t - s.end;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Linear interpolation between keys; clamps outside the key range. */
export function interpolateKeys(keys: CropKey[], t: number): { cx: number; cy: number } {
  if (keys.length === 0) return { cx: 0.5, cy: 0.5 };
  const first = keys[0]!;
  if (t <= first.t) return { cx: first.cx, cy: first.cy };
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo]!;
  const b = keys[hi]!;
  if (t >= b.t) return { cx: b.cx, cy: b.cy };
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { cx: a.cx + (b.cx - a.cx) * k, cy: a.cy + (b.cy - a.cy) * k };
}

/** Largest source window of the given aspect, centred on (cx, cy) and kept inside the frame. */
export function windowAround(srcW: number, srcH: number, aspect: number, cx: number, cy: number, zoom = 1): Rect {
  let w = srcW;
  let h = srcW / aspect;
  if (h > srcH) {
    h = srcH;
    w = srcH * aspect;
  }
  w /= zoom;
  h /= zoom;
  const x = Math.min(Math.max(cx * srcW - w / 2, 0), srcW - w);
  const y = Math.min(Math.max(cy * srcH - h / 2, 0), srcH - h);
  return { x, y, w, h };
}

/** Resolve the crop track at source time t into concrete panes for an outW×outH frame. */
export function layoutAt(track: CropTrack | null, t: number, outW: number, outH: number, srcW: number, srcH: number): FrameLayout {
  const seg = track ? segmentAt(track, t) : null;
  const outAspect = outW / outH;
  if (!seg) {
    return {
      layout: "crop",
      panes: [{ dst: { x: 0, y: 0, w: outW, h: outH }, src: windowAround(srcW, srcH, outAspect, 0.5, 0.5) }],
      blurredBackground: false,
    };
  }
  if (seg.layout === "split") {
    const half = outH / 2;
    const a = interpolateKeys(seg.keys, t);
    const b = interpolateKeys(seg.keys2 ?? seg.keys, t);
    const aspect = outW / half;
    return {
      layout: "split",
      panes: [
        { dst: { x: 0, y: 0, w: outW, h: half }, src: windowAround(srcW, srcH, aspect, a.cx, a.cy) },
        { dst: { x: 0, y: half, w: outW, h: half }, src: windowAround(srcW, srcH, aspect, b.cx, b.cy) },
      ],
      blurredBackground: false,
    };
  }
  if (seg.layout === "letterbox") {
    const h = Math.min(outH, (outW * srcH) / srcW);
    return {
      layout: "letterbox",
      panes: [{ dst: { x: 0, y: (outH - h) / 2, w: outW, h }, src: { x: 0, y: 0, w: srcW, h: srcH } }],
      blurredBackground: true,
    };
  }
  const c = interpolateKeys(seg.keys, t);
  return {
    layout: "crop",
    panes: [{ dst: { x: 0, y: 0, w: outW, h: outH }, src: windowAround(srcW, srcH, outAspect, c.cx, c.cy) }],
    blurredBackground: false,
  };
}

/**
 * CSS for a <video> absolutely positioned inside a pane-sized, overflow-hidden
 * box so that `pane.src` exactly fills it. Pure transforms: no re-encode.
 */
export function paneVideoStyle(pane: Pane, srcW: number, srcH: number): { width: number; height: number; left: number; top: number } {
  const scale = pane.dst.w / pane.src.w;
  return { width: srcW * scale, height: srcH * scale, left: -pane.src.x * scale, top: -pane.src.y * scale };
}

export function centerCropTrack(srcW: number, srcH: number, start: number, end: number): CropTrack {
  return {
    version: 1,
    srcW,
    srcH,
    segments: [{ start, end, layout: "crop", keys: [{ t: start, cx: 0.5, cy: 0.5 }] }],
  };
}
