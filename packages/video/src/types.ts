import type { CaptionStyle, CropTrack, EditState, Word } from "@klipz/shared";

/** Props of the "Clip" composition. */
export type ClipProps = {
  /** absolute URL of the source video (the CLI rewrites storage keys to loopback URLs) */
  sourceUrl: string;
  srcW: number;
  srcH: number;
  edit: EditState;
  cropTrack: CropTrack | null;
  customStyles?: CaptionStyle[];
  /** prefix turning a storage key (b-roll / audio src that is not absolute) into a URL */
  assetBaseUrl: string;
  /** editor-only overlay of platform UI margins; always off in renders */
  showSafeZone?: boolean;
};

/** Minimal clip description the render CLI accepts instead of a full EditState. */
export type ClipSeed = {
  start: number;
  end: number;
  words: Word[];
  hook?: string | null;
  keywords?: string[];
  styleId?: string;
};

/** What render.mjs / calculateMetadata accept: edit may be missing when `clip` is given. */
export type ClipInputProps = Omit<Partial<ClipProps>, "edit"> & {
  sourceUrl: string;
  edit?: EditState | null;
  clip?: ClipSeed | null;
};

export const CLIP_COMPOSITION_ID = "Clip";
