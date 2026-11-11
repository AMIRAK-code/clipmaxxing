"use client";

import type { CaptionStyle } from "@klipz/shared";
import type { CSSProperties } from "react";

/** Scale every "Npx" length inside a CSS shadow string. */
export function scaleShadow(shadow: string, k: number): string {
  if (!shadow || shadow === "none") return "none";
  return shadow.replace(/(-?\d*\.?\d+)px/g, (_m, n: string) => `${Math.round(Number(n) * k * 10) / 10}px`);
}

/**
 * Small static render of a caption style (font, colours, stroke, shadow,
 * highlight mode) using the real style data, so presets can be compared at a glance.
 */
export function CaptionMini({ style, scale = 0.24, words = ["BIG", "IDEA"] }: { style: CaptionStyle; scale?: number; words?: [string, string] }) {
  const text = (w: string) => (style.uppercase ? w.toUpperCase() : w);
  const base: CSSProperties = {
    fontFamily: `"${style.fontFamily}", sans-serif`,
    fontWeight: style.fontWeight,
    fontSize: Math.max(11, style.fontSize * scale),
    letterSpacing: `${style.letterSpacing}em`,
    lineHeight: style.lineHeight,
    color: style.color,
    WebkitTextStroke: style.strokeWidth > 0 ? `${Math.max(0.5, style.strokeWidth * scale * 0.5)}px ${style.strokeColor}` : undefined,
    paintOrder: "stroke fill",
    textShadow: scaleShadow(style.shadow, scale),
    whiteSpace: "nowrap",
  };
  const active: CSSProperties = { ...base, color: style.activeColor };
  if (style.highlight === "box") {
    active.background = style.boxColor;
    active.borderRadius = style.boxRadius * scale;
    active.padding = "0 4px";
  }
  if (style.highlight === "scale") {
    active.display = "inline-block";
    active.transform = "scale(1.18)";
  }
  if (style.highlight === "none") active.color = style.color;
  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{ background: style.pageBackground, padding: style.pagePadding * scale, borderRadius: 6 }}
      data-style-id={style.id}
    >
      <span style={base}>{text(words[0])}</span>
      <span style={active}>{text(words[1])}</span>
    </span>
  );
}
