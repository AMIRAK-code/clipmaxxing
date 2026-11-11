import type { CaptionStyle } from "@klipz/shared";

/** Scale factor (<= 1) that makes `measured` fit into `max`. Never scales up. */
export function fitScale(measured: number, max: number): number {
  if (!(measured > 0) || !(max > 0)) return 1;
  return Math.min(1, max / measured);
}

type TextFont = Pick<CaptionStyle, "fontFamily" | "fontWeight" | "fontSize" | "letterSpacing">;

let ctx: CanvasRenderingContext2D | null | undefined;
function getCtx(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    ctx = typeof document !== "undefined" ? document.createElement("canvas").getContext("2d") : null;
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Width in px of a string. Uses canvas when available, a conservative estimate otherwise. */
export function measureText(text: string, font: TextFont): number {
  const c = getCtx();
  const extra = font.letterSpacing * font.fontSize * text.length;
  if (c) {
    c.font = `${font.fontWeight} ${font.fontSize}px "${font.fontFamily}", sans-serif`;
    return c.measureText(text).width + extra;
  }
  return text.length * font.fontSize * 0.62 + extra;
}

/** Width of one line of words joined by a gap of `gap` px. */
export function lineWidth(words: string[], font: TextFont, gap: number): number {
  if (words.length === 0) return 0;
  return words.reduce((n, w) => n + measureText(w, font), 0) + gap * (words.length - 1);
}

/** Scale that keeps the widest of `lines` (plus horizontal `padding`) inside `maxWidth`. */
export function fitLines(lines: string[][], font: TextFont, gap: number, padding: number, maxWidth: number): number {
  const widest = lines.reduce((m, l) => Math.max(m, lineWidth(l, font, gap)), 0);
  return fitScale(widest + padding * 2, maxWidth);
}
