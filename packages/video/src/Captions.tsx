import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import {
  OUT_H,
  OUT_W,
  SAFE_ZONES,
  activeWordIndex,
  captionWordsOnTimeline,
  clampToSafeZone,
  layoutLines,
  pageAt,
  paginate,
  resolveCaptionStyle,
  type CaptionStyle,
  type EditState,
  type TimedCaptionWord,
} from "@klipz/shared";
import { entrance } from "./anim";
import { fitLines } from "./fit";

const SIDE_MARGIN = 48;

export function displayText(w: string, style: Pick<CaptionStyle, "uppercase">): string {
  return style.uppercase ? w.toUpperCase() : w;
}

/** Horizontal room for a caption block, honouring platform side margins. */
export function maxCaptionWidth(safeZone: EditState["safeZone"]): number {
  if (safeZone === "none") return OUT_W - SIDE_MARGIN * 2;
  const z = SAFE_ZONES[safeZone];
  const side = Math.max(SIDE_MARGIN, Math.max(z.left, z.right) * OUT_W);
  return OUT_W - side * 2;
}

export const Captions: React.FC<{ edit: EditState; customStyles?: CaptionStyle[] }> = ({ edit, customStyles }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const style = useMemo(
    () => resolveCaptionStyle(edit.captions.styleId, edit.captions.overrides, customStyles ?? []),
    [edit.captions.styleId, edit.captions.overrides, customStyles],
  );
  const pages = useMemo(
    () => paginate(captionWordsOnTimeline(edit.video, edit.captions.words), style),
    [edit.video, edit.captions.words, style],
  );
  if (!edit.captions.enabled) return null;

  const t = frame / fps;
  const page = pageAt(pages, t);
  if (!page) return null;

  const active = activeWordIndex(page, t);
  const lines = layoutLines(page.words, style.maxCharsPerLine);
  const gap = style.fontSize * 0.28;
  const maxW = maxCaptionWidth(edit.safeZone);
  const scaleFit = fitLines(
    lines.map((l) => l.map((w) => displayText(w.w, style))),
    style,
    gap,
    style.pagePadding,
    maxW,
  );
  const anim = entrance(style.anim, frame - Math.round(page.start * fps), fps);

  const lineH = style.fontSize * style.lineHeight;
  const emojiWord = style.emoji ? page.words.find((w) => w.emoji) : undefined;
  const blockFrac = (lines.length * lineH + style.pagePadding * 2 + (emojiWord ? style.fontSize * 1.1 : 0)) / OUT_H;
  const zone = edit.safeZone === "none" ? null : SAFE_ZONES[edit.safeZone];
  const pos = clampToSafeZone(style.position, zone, blockFrac * scaleFit);

  return (
    <div style={{ position: "absolute", left: 0, top: pos * OUT_H, width: OUT_W, display: "flex", justifyContent: "center" }}>
      <div
        style={{
          transform: `translateY(calc(-50% + ${anim.translateY}px)) scale(${scaleFit * anim.scale})`,
          transformOrigin: "center center",
          opacity: anim.opacity,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          background: style.pageBackground,
          padding: style.pagePadding,
          borderRadius: style.pagePadding > 0 ? Math.max(12, style.boxRadius) : 0,
          whiteSpace: "nowrap",
        }}
      >
        {emojiWord ? (
          <div style={{ fontSize: style.fontSize * 1.1, lineHeight: 1.1, marginBottom: style.fontSize * 0.08 }}>{emojiWord.emoji}</div>
        ) : null}
        {lines.map((line, li) => (
          <div key={li} style={{ display: "flex", gap, justifyContent: "center", lineHeight: style.lineHeight }}>
            {line.map((w) => (
              <CaptionWordView key={w.id} word={w} index={page.words.indexOf(w)} active={active} style={style} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

const CaptionWordView: React.FC<{ word: TimedCaptionWord; index: number; active: number; style: CaptionStyle }> = ({
  word,
  index,
  active,
  style,
}) => {
  const isActive = index === active;
  const spoken = index <= active;
  let color = style.color;
  let background: string | undefined;
  let scale = 1;

  switch (style.highlight) {
    case "color":
      if (isActive) color = style.activeColor;
      break;
    case "karaoke":
      if (spoken) color = style.activeColor;
      break;
    case "box":
      if (isActive) {
        color = style.activeColor;
        background = style.boxColor;
      }
      break;
    case "scale":
      if (isActive) {
        color = style.activeColor;
        scale = 1.18;
      }
      break;
    case "none":
      break;
  }
  // emphasised keywords keep their own colour unless a box highlight needs readable text
  if (word.emph && !(style.highlight === "box" && isActive)) color = style.emphasisColor;

  return (
    <span
      style={{
        display: "inline-block",
        fontFamily: `"${style.fontFamily}", sans-serif`,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        letterSpacing: `${style.letterSpacing}em`,
        color,
        background,
        borderRadius: style.boxRadius,
        padding: background ? `0 ${style.fontSize * 0.12}px` : undefined,
        margin: background ? `0 ${-style.fontSize * 0.12}px` : undefined,
        transform: scale === 1 ? undefined : `scale(${scale})`,
        WebkitTextStroke: style.strokeWidth > 0 ? `${style.strokeWidth}px ${style.strokeColor}` : undefined,
        paintOrder: "stroke fill",
        textShadow: style.shadow === "none" ? undefined : style.shadow,
        strokeLinejoin: "round",
      }}
    >
      {displayText(word.w, style)}
    </span>
  );
};
