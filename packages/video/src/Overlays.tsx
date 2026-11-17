import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import {
  HOOK_BASE_SIZE,
  OUT_H,
  OUT_W,
  SAFE_ZONES,
  baseDirection,
  clampToSafeZone,
  fontStack,
  fontWeightOf,
  isTransparent,
  resolveHookStyle,
  type EditState,
} from "@klipz/shared";
import { hookEnvelope, entrance } from "./anim";
import { fitScale, measureText } from "./fit";
import { maxCaptionWidth } from "./Captions";

/** The hook card's text split into lines of at most 14 characters (a longer word gets a line of its own). */
export function hookLines(label: string): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of label.split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > 14) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Everything about the hook card that does not change from frame to frame: its lines, the scale that fits
 * them on screen, its vertical centre and its CSS. Ported to the fast renderer as ass.add_hook.
 */
export function hookCardLayout(edit: EditState): { label: string; lines: string[]; fit: number; pos: number; style: React.CSSProperties } {
  const style = resolveHookStyle(edit.hook);
  const fontSize = style.fontSize;
  const fontWeight = fontWeightOf(style.fontFamily);
  // padding, corners and shadow were made for the 92 px card and grow / shrink with the text
  const u = fontSize / HOOK_BASE_SIZE;
  const boxed = !isTransparent(style.background);
  const label = style.uppercase ? edit.hook.text.trim().toUpperCase() : edit.hook.text.trim();
  // wrap into lines of <= 14 chars, then shrink if still too wide
  const lines = hookLines(label);
  const font = { fontFamily: style.fontFamily, fontWeight, fontSize, letterSpacing: 0 };
  const widest = lines.reduce((m, l) => Math.max(m, measureText(l, font)), 0);
  const fit = fitScale(widest + 80 * u, maxCaptionWidth(edit.safeZone));
  const zone = edit.safeZone === "none" ? null : SAFE_ZONES[edit.safeZone];
  return {
    label,
    lines,
    fit,
    pos: clampToSafeZone(0.3, zone, 0.2),
    style: {
      textAlign: "center",
      direction: baseDirection([label]),
      fontFamily: fontStack(style.fontFamily),
      fontWeight,
      fontSize,
      lineHeight: 1.1,
      color: style.color,
      background: boxed ? style.background : "transparent",
      padding: `${28 * u}px ${40 * u}px`,
      borderRadius: 32 * u,
      boxShadow: boxed ? `0 ${10 * u}px ${40 * u}px rgba(0,0,0,0.5)` : "none",
      ...(style.strokeWidth > 0
        ? { WebkitTextStroke: `${style.strokeWidth}px ${style.strokeColor}`, paintOrder: "stroke fill", strokeLinejoin: "round" }
        : {}),
      whiteSpace: "nowrap",
    },
  };
}

export const HookCard: React.FC<{ edit: EditState }> = ({ edit }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { enabled, text, durationSec } = edit.hook;
  const durF = Math.round(durationSec * fps);
  if (!enabled || !text.trim() || frame >= durF) return null;

  const env = hookEnvelope(frame, durF, fps);
  const inAnim = entrance("bounce", Math.min(frame, durF - frame), fps);
  const { lines, fit, pos, style } = hookCardLayout(edit);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: "rgba(0,0,0,0.38)", opacity: env }} />
      <div style={{ position: "absolute", left: 0, top: pos * OUT_H, width: OUT_W, display: "flex", justifyContent: "center" }}>
        <div style={{ transform: `translateY(-50%) scale(${fit * (0.85 + 0.15 * inAnim.scale)})`, opacity: env, ...style }}>
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const ProgressBar: React.FC<{ edit: EditState; totalFrames: number }> = ({ edit, totalFrames }) => {
  const frame = useCurrentFrame();
  const { enabled, color, position, height } = edit.progressBar;
  if (!enabled) return null;
  const pct = Math.min(1, (frame + 1) / Math.max(1, totalFrames)) * 100;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        width: `${pct}%`,
        height,
        background: color,
        ...(position === "top" ? { top: 0 } : { bottom: 0 }),
      }}
    />
  );
};

/** Editor-only: shades the regions platform UI covers. */
export const SafeZoneOverlay: React.FC<{ safeZone: EditState["safeZone"] }> = ({ safeZone }) => {
  if (safeZone === "none") return null;
  const z = SAFE_ZONES[safeZone];
  const shade = "rgba(255,60,60,0.28)";
  const line = "2px dashed rgba(255,255,255,0.8)";
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: OUT_W, height: z.top * OUT_H, background: shade, borderBottom: line }} />
      <div style={{ position: "absolute", left: 0, bottom: 0, width: OUT_W, height: z.bottom * OUT_H, background: shade, borderTop: line }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: z.top * OUT_H,
          bottom: z.bottom * OUT_H,
          width: z.left * OUT_W,
          background: shade,
          borderRight: line,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: z.top * OUT_H,
          bottom: z.bottom * OUT_H,
          width: z.right * OUT_W,
          background: shade,
          borderLeft: line,
        }}
      />
    </AbsoluteFill>
  );
};
