import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import {
  LOOKS,
  OUT_H,
  OUT_W,
  duckGainAt,
  layoutAt,
  paneVideoStyle,
  pieceDuration,
  pieceOffsets,
  zoomAt,
  type CropTrack,
  type EditState,
  type Pane,
  type VideoPiece,
} from "@klipz/shared";
import { transitionStyle } from "./anim";

export interface PieceFrames {
  /** output frame where the piece starts */
  from: number;
  duration: number;
}

/** Frame placement of every piece; cumulative rounding so pieces tile exactly. */
export function pieceFrames(pieces: VideoPiece[], fps: number): PieceFrames[] {
  const offsets = pieceOffsets(pieces);
  return pieces.map((p, i) => {
    const from = Math.round(offsets[i]! * fps);
    const end = Math.round((offsets[i]! + pieceDuration(p)) * fps);
    return { from, duration: Math.max(1, end - from) };
  });
}

const PaneVideo: React.FC<{
  pane: Pane;
  srcW: number;
  srcH: number;
  src: string;
  trimBefore: number;
  trimAfter: number;
  muted: boolean;
  volume: (frame: number) => number;
}> = ({ pane, srcW, srcH, src, trimBefore, trimAfter, muted, volume }) => {
  const v = paneVideoStyle(pane, srcW, srcH);
  return (
    <div
      style={{
        position: "absolute",
        left: pane.dst.x,
        top: pane.dst.y,
        width: pane.dst.w,
        height: pane.dst.h,
        overflow: "hidden",
      }}
    >
      <OffthreadVideo
        src={src}
        trimBefore={trimBefore}
        trimAfter={trimAfter}
        muted={muted}
        volume={volume}
        style={{ position: "absolute", left: v.left, top: v.top, width: v.width, height: v.height, objectFit: "fill", maxWidth: "none" }}
      />
    </div>
  );
};

const PieceView: React.FC<{
  piece: VideoPiece;
  from: number;
  sourceUrl: string;
  srcW: number;
  srcH: number;
  edit: EditState;
  cropTrack: CropTrack | null;
}> = ({ piece, from, sourceUrl, srcW, srcH, edit, cropTrack }) => {
  const local = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tSrc = piece.srcStart + local / fps;
  const tOut = (from + local) / fps;

  const layout = layoutAt(cropTrack, tSrc, OUT_W, OUT_H, srcW, srcH);
  const trimBefore = Math.round(piece.srcStart * fps);
  // trimAfter must stay above trimBefore even for sub-frame pieces
  const trimAfter = Math.max(trimBefore + 1, Math.round(piece.srcEnd * fps));
  const mainVolume = (f: number) => duckGainAt(edit, (from + f) / fps);
  const silent = () => 0;

  const tr = piece.transitionIn;
  const trFrames = tr && tr.type !== "none" ? Math.max(1, Math.round(tr.durationSec * fps)) : 0;
  const ts = trFrames > 0 && local < trFrames ? transitionStyle(tr?.type, local / trFrames, OUT_W) : transitionStyle("none", 1);

  const zoom = zoomAt(edit.zooms, tOut);
  const filter = (LOOKS[edit.look] as (typeof LOOKS)[keyof typeof LOOKS] | undefined)?.filter ?? "none";

  const bgScale = Math.max(OUT_W / srcW, OUT_H / srcH);

  return (
    <AbsoluteFill
      style={{
        opacity: ts.opacity,
        transform: `translateX(${ts.translateX}px) scale(${ts.scale})`,
        transformOrigin: "center center",
      }}
    >
      <AbsoluteFill style={{ filter: filter === "none" ? undefined : filter, overflow: "hidden" }}>
        <AbsoluteFill style={{ transform: zoom === 1 ? undefined : `scale(${zoom})`, transformOrigin: "center center" }}>
          {layout.blurredBackground ? (
            <div
              key="bg"
              style={{ position: "absolute", inset: 0, overflow: "hidden", filter: "blur(36px) brightness(0.55)", transform: "scale(1.15)" }}
            >
              <OffthreadVideo
                src={sourceUrl}
                trimBefore={trimBefore}
                trimAfter={trimAfter}
                muted
                volume={silent}
                style={{
                  position: "absolute",
                  width: srcW * bgScale,
                  height: srcH * bgScale,
                  left: (OUT_W - srcW * bgScale) / 2,
                  top: (OUT_H - srcH * bgScale) / 2,
                  maxWidth: "none",
                }}
              />
            </div>
          ) : null}
          {layout.panes.map((pane, i) => (
            <PaneVideo
              key={`p${i}`}
              pane={pane}
              srcW={srcW}
              srcH={srcH}
              src={sourceUrl}
              trimBefore={trimBefore}
              trimAfter={trimAfter}
              muted={i > 0}
              volume={i === 0 ? mainVolume : silent}
            />
          ))}
        </AbsoluteFill>
      </AbsoluteFill>
      {ts.flash > 0 ? <AbsoluteFill style={{ background: "#fff", opacity: ts.flash }} /> : null}
    </AbsoluteFill>
  );
};

export const MainTrack: React.FC<{
  edit: EditState;
  sourceUrl: string;
  srcW: number;
  srcH: number;
  cropTrack: CropTrack | null;
}> = ({ edit, sourceUrl, srcW, srcH, cropTrack }) => {
  const { fps } = useVideoConfig();
  const frames = pieceFrames(edit.video, fps);
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      {edit.video.map((piece, i) => (
        <Sequence key={piece.id} from={frames[i]!.from} durationInFrames={frames[i]!.duration} name={`piece ${i + 1}`}>
          <PieceView
            piece={piece}
            from={frames[i]!.from}
            sourceUrl={sourceUrl}
            srcW={srcW}
            srcH={srcH}
            edit={edit}
            cropTrack={cropTrack}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
