import {
  OUT_FPS,
  createDefaultEditState,
  totalDuration,
  type EditState,
} from "@klipz/shared";
import type { ClipInputProps, ClipProps } from "./types";

/** Duration of the rendered clip in frames. The hook card overlays, it never extends. */
export function clipDurationInFrames(edit: Pick<EditState, "video">, fps: number = OUT_FPS): number {
  return Math.max(1, Math.round(totalDuration(edit.video) * fps));
}

const ABSOLUTE = /^(https?:|data:|blob:)/i;

/** Turn a storage key into a URL below `assetBaseUrl`; absolute URLs pass through. */
export function resolveSrc(src: string, assetBaseUrl: string): string {
  if (ABSOLUTE.test(src)) return src;
  const key = src.replace(/^\/+/, "");
  if (!assetBaseUrl) return key;
  const base = assetBaseUrl.endsWith("/") ? assetBaseUrl : `${assetBaseUrl}/`;
  return base + key;
}

/** Fill every optional/missing part of an EditState so the composition never crashes on old data. */
export function normalizeEdit(edit: EditState): EditState {
  const defaults = createDefaultEditState({ start: 0, end: 1, words: [] });
  const e = edit as Partial<EditState>;
  return {
    ...defaults,
    ...e,
    version: 1,
    video: e.video && e.video.length > 0 ? e.video : defaults.video,
    captions: { ...defaults.captions, ...(e.captions ?? {}), words: e.captions?.words ?? [], overrides: e.captions?.overrides ?? {} },
    broll: e.broll ?? [],
    audio: e.audio ?? [],
    texts: e.texts ?? [],
    zooms: e.zooms ?? [],
    hook: { ...defaults.hook, ...(e.hook ?? {}) },
    progressBar: { ...defaults.progressBar, ...(e.progressBar ?? {}) },
  };
}

/**
 * Accepts loosely-typed input (from the CLI or the editor), derives the edit from
 * `clip` when none is given and returns complete ClipProps.
 */
export function normalizeProps(input: ClipInputProps): ClipProps {
  let edit: EditState;
  const given = input.edit ?? null;
  const emptyVideo = !!given && (!Array.isArray(given.video) || given.video.length === 0);
  if (given && emptyVideo && !input.clip) {
    // never silently render a placeholder second of the source
    throw new Error("edit.video is empty: nothing to render (give at least one video piece or a `clip` range)");
  }
  if (given && !emptyVideo) {
    // an explicit edit always wins over `clip`
    edit = normalizeEdit(given);
  } else if (input.clip) {
    const c = input.clip;
    edit = createDefaultEditState({
      start: c.start,
      end: c.end,
      words: c.words,
      hook: c.hook ?? null,
      styleId: c.styleId,
      keywords: c.keywords,
    });
    if (c.hook) edit = { ...edit, hook: { ...edit.hook, enabled: true } };
  } else {
    throw new Error("props need either `edit` or `clip`");
  }
  const srcW = input.srcW ?? input.cropTrack?.srcW ?? 1920;
  const srcH = input.srcH ?? input.cropTrack?.srcH ?? 1080;
  return {
    sourceUrl: input.sourceUrl,
    srcW,
    srcH,
    edit,
    cropTrack: input.cropTrack ?? null,
    customStyles: input.customStyles ?? [],
    assetBaseUrl: input.assetBaseUrl ?? "",
    showSafeZone: input.showSafeZone ?? false,
  };
}
