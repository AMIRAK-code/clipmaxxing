import React from "react";
import { Composition } from "remotion";
import { OUT_FPS, OUT_H, OUT_W } from "@klipz/shared";
import { ClipComposition } from "./ClipComposition";
import { defaultProps } from "./default-props";
import { clipDurationInFrames, normalizeProps } from "./props";
import { CLIP_COMPOSITION_ID, type ClipInputProps, type ClipProps } from "./types";

export const RemotionRoot: React.FC = () => (
  <Composition
    id={CLIP_COMPOSITION_ID}
    component={ClipComposition}
    width={OUT_W}
    height={OUT_H}
    fps={OUT_FPS}
    durationInFrames={clipDurationInFrames(defaultProps.edit)}
    defaultProps={defaultProps}
    calculateMetadata={({ props }) => {
      // props may come from the render CLI with `clip` instead of `edit`
      const resolved: ClipProps = normalizeProps(props as unknown as ClipInputProps);
      return {
        durationInFrames: clipDurationInFrames(resolved.edit),
        fps: OUT_FPS,
        width: OUT_W,
        height: OUT_H,
        props: resolved,
      };
    }}
  />
);
