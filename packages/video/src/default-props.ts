import { createDefaultEditState, type Word } from "@klipz/shared";
import type { ClipInputProps, ClipProps } from "./types";

const words: Word[] = "This is the one thing nobody tells you about 10x growth".split(" ").map((w, i) => ({
  w,
  s: i * 0.4,
  e: i * 0.4 + 0.35,
}));

/** Plain props for the Remotion studio / Player placeholder. Point sourceUrl at a real video. */
export const defaultProps: ClipProps = {
  sourceUrl: "http://127.0.0.1:3000/api/files/sample.mp4",
  srcW: 1920,
  srcH: 1080,
  edit: createDefaultEditState({ start: 0, end: 4.4, words, hook: "Nobody tells you this" }),
  cropTrack: null,
  customStyles: [],
  assetBaseUrl: "/api/files/",
  showSafeZone: false,
};

/**
 * What the Composition registers as its defaultProps. It deliberately has NO `edit`:
 * Remotion merges CLI input props over defaultProps, so a default `edit` would shadow a
 * `clip` passed by the render CLI. The studio placeholder derives its edit from `clip`.
 */
export const compositionDefaults: ClipInputProps = {
  sourceUrl: defaultProps.sourceUrl,
  srcW: defaultProps.srcW,
  srcH: defaultProps.srcH,
  clip: { start: 0, end: 4.4, words, hook: "Nobody tells you this" },
  cropTrack: null,
  customStyles: [],
  assetBaseUrl: defaultProps.assetBaseUrl,
  showSafeZone: false,
};

/**
 * Props the composition resolves its metadata from. Remotion would merge `defaultProps` UNDER the CLI
 * input props, so the placeholder clip would silently stand in for an edit/clip that is empty or
 * missing. The Composition therefore registers no defaultProps; only the studio (no sourceUrl at all)
 * gets the placeholder, every real render is normalised strictly from what it was given.
 */
export function resolveCompositionProps(props: ClipInputProps): ClipInputProps {
  return props && props.sourceUrl ? props : compositionDefaults;
}
