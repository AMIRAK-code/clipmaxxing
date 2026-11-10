import type { CaptionWord, EditState, VideoPiece, Word } from "./types";

// The main video track is an ordered list of source ranges. Output time is the
// concatenation of those ranges, so cutting a range out ("ripple delete")
// automatically closes the gap and drops the captions that lived inside it.

let counter = 0;
export function uid(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const pieceDuration = (p: VideoPiece): number => Math.max(0, p.srcEnd - p.srcStart);

export function totalDuration(pieces: VideoPiece[]): number {
  return pieces.reduce((sum, p) => sum + pieceDuration(p), 0);
}

/** Output-time start of every piece. */
export function pieceOffsets(pieces: VideoPiece[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const p of pieces) {
    out.push(t);
    t += pieceDuration(p);
  }
  return out;
}

/** Source time → output time, or null when that moment was cut out. */
export function srcToOut(pieces: VideoPiece[], tSrc: number): number | null {
  let offset = 0;
  for (const p of pieces) {
    if (tSrc >= p.srcStart && tSrc < p.srcEnd) return offset + (tSrc - p.srcStart);
    offset += pieceDuration(p);
  }
  return null;
}

/** Output time → {piece index, source time}. Clamps to the last frame. */
export function outToSrc(pieces: VideoPiece[], tOut: number): { index: number; tSrc: number } | null {
  if (pieces.length === 0) return null;
  let offset = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    const d = pieceDuration(p);
    if (tOut < offset + d) return { index: i, tSrc: p.srcStart + Math.max(0, tOut - offset) };
    offset += d;
  }
  const last = pieces[pieces.length - 1]!;
  return { index: pieces.length - 1, tSrc: last.srcEnd };
}

/** Split the piece under output time t into two. No-op at piece edges. */
export function splitAt(pieces: VideoPiece[], tOut: number, minLen = 0.05): VideoPiece[] {
  const hit = outToSrc(pieces, tOut);
  if (!hit) return pieces;
  const p = pieces[hit.index]!;
  if (hit.tSrc - p.srcStart < minLen || p.srcEnd - hit.tSrc < minLen) return pieces;
  const left: VideoPiece = { ...p, srcEnd: hit.tSrc };
  const right: VideoPiece = { id: uid("v"), srcStart: hit.tSrc, srcEnd: p.srcEnd };
  return [...pieces.slice(0, hit.index), left, right, ...pieces.slice(hit.index + 1)];
}

/** Remove a piece; later pieces move left because offsets are derived. */
export function rippleDelete(pieces: VideoPiece[], id: string): VideoPiece[] {
  if (pieces.length <= 1) return pieces;
  return pieces.filter((p) => p.id !== id);
}

/** Remove an output-time range, splitting pieces where needed. */
export function rippleDeleteRange(pieces: VideoPiece[], fromOut: number, toOut: number): VideoPiece[] {
  if (toOut <= fromOut) return pieces;
  const out: VideoPiece[] = [];
  let offset = 0;
  for (const p of pieces) {
    const d = pieceDuration(p);
    const a = offset;
    const b = offset + d;
    offset = b;
    if (b <= fromOut || a >= toOut) {
      out.push(p);
      continue;
    }
    if (a < fromOut) out.push({ ...p, srcEnd: p.srcStart + (fromOut - a) });
    if (b > toOut) out.push({ id: a < fromOut ? uid("v") : p.id, srcStart: p.srcStart + (toOut - a), srcEnd: p.srcEnd });
  }
  return out.length > 0 ? out : pieces;
}

/**
 * Trim one edge of a piece. The edge can extend outward until it meets the
 * neighbouring piece's source range or the clip bounds.
 */
export function trimPiece(
  pieces: VideoPiece[],
  id: string,
  edge: "start" | "end",
  newSrc: number,
  bounds: { min: number; max: number },
  minLen = 0.1,
): VideoPiece[] {
  return pieces.map((p) => {
    if (p.id !== id) return p;
    if (edge === "start") {
      const v = Math.min(Math.max(newSrc, bounds.min), p.srcEnd - minLen);
      return { ...p, srcStart: v };
    }
    const v = Math.max(Math.min(newSrc, bounds.max), p.srcStart + minLen);
    return { ...p, srcEnd: v };
  });
}

export interface TimedCaptionWord extends CaptionWord {
  /** output-timeline times */
  os: number;
  oe: number;
}

/** Caption words that survive the cut, re-timed onto the output timeline. */
export function captionWordsOnTimeline(pieces: VideoPiece[], words: CaptionWord[]): TimedCaptionWord[] {
  const offsets = pieceOffsets(pieces);
  const out: TimedCaptionWord[] = [];
  pieces.forEach((p, i) => {
    const off = offsets[i]!;
    for (const w of words) {
      if (w.hidden) continue;
      const mid = (w.s + w.e) / 2;
      if (mid < p.srcStart || mid >= p.srcEnd) continue;
      const os = off + Math.max(0, w.s - p.srcStart);
      const oe = off + Math.min(pieceDuration(p), w.e - p.srcStart);
      out.push({ ...w, os, oe: Math.max(oe, os + 0.04) });
    }
  });
  return out.sort((a, b) => a.os - b.os);
}

export function wordsToCaptionWords(words: Word[], start: number, end: number): CaptionWord[] {
  return words
    .filter((w) => w.e > start && w.s < end)
    .map((w, i) => ({ id: `w${i}_${Math.round(w.s * 1000)}`, w: w.w.trim(), s: w.s, e: w.e, spk: w.spk }))
    .filter((w) => w.w.length > 0);
}

/**
 * Main-audio gain at output time t: `duckLevel` while any ducking b-roll or
 * audio item is audible, with a short ramp so the change is not a click.
 */
export function duckGainAt(edit: Pick<EditState, "broll" | "audio" | "duckLevel" | "volume">, t: number, ramp = 0.25): number {
  let duck = 0;
  for (const item of [...edit.broll, ...edit.audio]) {
    if (!item.duck || item.volume <= 0) continue;
    const a = item.start;
    const b = item.start + item.duration;
    if (t <= a - ramp || t >= b + ramp) continue;
    const k = t < a ? (t - (a - ramp)) / ramp : t > b ? 1 - (t - b) / ramp : 1;
    duck = Math.max(duck, k);
  }
  return edit.volume * (1 - duck * (1 - edit.duckLevel));
}

/** Interpolated zoom scale at output time t (1 = no zoom). */
export function zoomAt(zooms: EditState["zooms"], t: number): number {
  if (zooms.length === 0) return 1;
  const keys = [...zooms].sort((a, b) => a.t - b.t);
  const first = keys[0]!;
  if (t <= first.t) return first.scale;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= a.t && t <= b.t) {
      if (b.ease === "snap") return a.scale;
      let k = (t - a.t) / Math.max(1e-6, b.t - a.t);
      if (b.ease === "ease") k = k * k * (3 - 2 * k);
      return a.scale + (b.scale - a.scale) * k;
    }
  }
  return keys[keys.length - 1]!.scale;
}
