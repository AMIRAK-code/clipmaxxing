import { createDefaultEditState, type Word } from "@klipz/shared";
import type { ClipProps } from "./types";

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
