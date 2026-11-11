import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { OUT_H, OUT_W, SAFE_ZONES, clampToSafeZone, type EditState } from "@klipz/shared";
import { hookEnvelope, entrance } from "./anim";
import { fitScale, measureText } from "./fit";
import { maxCaptionWidth } from "./Captions";

export const HookCard: React.FC<{ edit: EditState }> = ({ edit }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { enabled, text, durationSec } = edit.hook;
  const durF = Math.round(durationSec * fps);
  if (!enabled || !text.trim() || frame >= durF) return null;

  const env = hookEnvelope(frame, durF, fps);
  const inAnim = entrance("bounce", Math.min(frame, durF - frame), fps);
  const fontSize = 92;
  const label = text.trim().toUpperCase();
  // wrap into lines of <= 14 chars, then shrink if still too wide
  const lines: string[] = [];
  let cur = "";
  for (const word of label.split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > 14) {
      lines.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  const font = { fontFamily: "Montserrat", fontWeight: 900, fontSize, letterSpacing: 0 };
  const widest = lines.reduce((m, l) => Math.max(m, measureText(l, font)), 0);
  const scale = fitScale(widest + 80, maxCaptionWidth(edit.safeZone));
  const zone = edit.safeZone === "none" ? null : SAFE_ZONES[edit.safeZone];
  const pos = clampToSafeZone(0.3, zone, 0.2);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: "rgba(0,0,0,0.38)", opacity: env }} />
      <div style={{ position: "absolute", left: 0, top: pos * OUT_H, width: OUT_W, display: "flex", justifyContent: "center" }}>
        <div
          style={{
            transform: `translateY(-50%) scale(${scale * (0.85 + 0.15 * inAnim.scale)})`,
            opacity: env,
            textAlign: "center",
            fontFamily: '"Montserrat", sans-serif',
            fontWeight: 900,
            fontSize,
            lineHeight: 1.1,
            color: "#FFFFFF",
            background: "rgba(124,58,237,0.92)",
            padding: "28px 40px",
            borderRadius: 32,
            boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
            whiteSpace: "nowrap",
          }}
        >
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
