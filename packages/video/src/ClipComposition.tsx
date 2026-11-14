import React from "react";
import { AbsoluteFill, useRemotionEnvironment, useVideoConfig } from "remotion";
import { Captions } from "./Captions";
import { useCaptionFonts } from "./fonts";
import { AudioLayer, BrollLayer, TextLayer } from "./Items";
import { effectiveCropTrack } from "@klipz/shared";
import { MainTrack } from "./MainTrack";
import { HookCard, ProgressBar, SafeZoneOverlay } from "./Overlays";
import type { ClipProps } from "./types";

/** 1080x1920 @ 30fps clip: reframed video, b-roll, captions, hook card, progress bar. */
export const ClipComposition: React.FC<ClipProps> = (props) => {
  const { edit, sourceUrl, srcW, srcH, cropTrack, customStyles, assetBaseUrl, showSafeZone } = props;
  const { durationInFrames } = useVideoConfig();
  const env = useRemotionEnvironment();
  useCaptionFonts();

  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      {/* a frame set by hand in the editor replaces the automatic (face-tracking) crop track */}
      <MainTrack edit={edit} sourceUrl={sourceUrl} srcW={srcW} srcH={srcH} cropTrack={effectiveCropTrack(edit, cropTrack, srcW, srcH)} />
      <BrollLayer items={edit.broll} assetBaseUrl={assetBaseUrl} />
      <AudioLayer items={edit.audio} assetBaseUrl={assetBaseUrl} />
      <HookCard edit={edit} />
      <Captions edit={edit} customStyles={customStyles} />
      <TextLayer items={edit.texts} />
      <ProgressBar edit={edit} totalFrames={durationInFrames} />
      {showSafeZone && !env.isRendering ? <SafeZoneOverlay safeZone={edit.safeZone} /> : null}
    </AbsoluteFill>
  );
};
