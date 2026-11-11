import React from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { OUT_H, OUT_W, type AudioItem, type BrollItem, type TextItem } from "@klipz/shared";
import { entrance } from "./anim";
import { resolveSrc } from "./props";

const span = (start: number, duration: number, fps: number) => {
  const from = Math.round(start * fps);
  return { from, duration: Math.max(1, Math.round((start + duration) * fps) - from) };
};

const PIP_W = 760;
const PIP_H = 428;

export const BrollLayer: React.FC<{ items: BrollItem[]; assetBaseUrl: string }> = ({ items, assetBaseUrl }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {items.map((it) => {
        const s = span(it.start, it.duration, fps);
        const src = resolveSrc(it.src, assetBaseUrl);
        const cover = it.fit === "cover";
        const media =
          it.kind === "image" ? (
            <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <OffthreadVideo
              src={src}
              trimBefore={Math.round(it.srcOffset * fps)}
              volume={it.volume}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          );
        return (
          <Sequence key={it.id} from={s.from} durationInFrames={s.duration} name={`broll ${it.id}`}>
            {cover ? (
              <AbsoluteFill>{media}</AbsoluteFill>
            ) : (
              <div
                style={{
                  position: "absolute",
                  left: (OUT_W - PIP_W) / 2,
                  top: OUT_H * 0.14,
                  width: PIP_W,
                  height: PIP_H,
                  borderRadius: 36,
                  overflow: "hidden",
                  border: "6px solid #fff",
                  boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
                }}
              >
                {media}
              </div>
            )}
          </Sequence>
        );
      })}
    </>
  );
};

export const AudioLayer: React.FC<{ items: AudioItem[]; assetBaseUrl: string }> = ({ items, assetBaseUrl }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {items.map((it) => {
        const s = span(it.start, it.duration, fps);
        return (
          <Sequence key={it.id} from={s.from} durationInFrames={s.duration} name={`audio ${it.kind}`}>
            <Audio src={resolveSrc(it.src, assetBaseUrl)} trimBefore={Math.round(it.srcOffset * fps)} volume={it.volume} />
          </Sequence>
        );
      })}
    </>
  );
};

const TextView: React.FC<{ item: TextItem }> = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = entrance(item.anim, frame, fps);
  const hasBg = item.background && item.background !== "transparent";
  return (
    <div
      style={{
        position: "absolute",
        left: item.x * OUT_W,
        top: item.y * OUT_H,
        transform: `translate(-50%, calc(-50% + ${a.translateY}px)) scale(${a.scale})`,
        opacity: a.opacity,
        fontFamily: `"${item.fontFamily}", sans-serif`,
        fontWeight: item.fontWeight,
        fontSize: item.fontSize,
        color: item.color,
        background: hasBg ? item.background : undefined,
        padding: hasBg ? "12px 24px" : undefined,
        borderRadius: hasBg ? 16 : undefined,
        textAlign: "center",
        width: "max-content",
        maxWidth: OUT_W - 96,
        whiteSpace: "pre-wrap",
        textShadow: hasBg ? undefined : "0 3px 12px rgba(0,0,0,0.7)",
      }}
    >
      {item.text}
    </div>
  );
};

export const TextLayer: React.FC<{ items: TextItem[] }> = ({ items }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {items.map((it) => {
        const s = span(it.start, it.duration, fps);
        return (
          <Sequence key={it.id} from={s.from} durationInFrames={s.duration} name={`text ${it.id}`}>
            <TextView item={it} />
          </Sequence>
        );
      })}
    </>
  );
};
