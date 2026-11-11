import {
  CAPTION_PRESETS,
  editWordText,
  pieceDuration,
  pieceOffsets,
  emojiFor,
  heuristicEmphasis,
  resolveCaptionStyle,
  rippleDelete,
  splitAt,
  totalDuration,
  trimPiece,
  type AudioItem,
  type BrollItem,
  type CaptionStyle,
  type EditState,
  type LookId,
  type Provider,
  type TextItem,
  type TransitionType,
  type ZoomKey,
} from "@klipz/shared";
import type { Draft } from "immer";

/** A pure edit: mutate the immer draft. The store turns it into an undoable step. */
export type Recipe = (d: Draft<EditState>) => void;

export const MAX_HANDLE_SEC = 5;
export const MIN_ITEM_SEC = 0.2;
export const MIN_PIECE_SEC = 0.1;

export const clampNum = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Where trimming may reach: the clip range plus up to 5 s of handle each side, within the source. */
export function trimBounds(clip: { start_sec: number; end_sec: number }, sourceDuration: number | null): { min: number; max: number } {
  return {
    min: Math.max(0, clip.start_sec - MAX_HANDLE_SEC),
    max: Math.min(sourceDuration ?? Number.POSITIVE_INFINITY, clip.end_sec + MAX_HANDLE_SEC),
  };
}

export const duration = (e: Pick<EditState, "video">): number => totalDuration(e.video);

// ── video ───────────────────────────────────────────────────────────────
export const splitAtTime = (tOut: number): Recipe => (d) => {
  d.video = splitAt(d.video, tOut);
};

export const rippleDeletePiece = (id: string): Recipe => (d) => {
  const idx = d.video.findIndex((p) => p.id === id);
  if (idx < 0 || d.video.length <= 1) return;
  const a = pieceOffsets(d.video)[idx]!;
  const len = pieceDuration(d.video[idx]!);
  const b = a + len;
  // Everything on the output timeline after the cut moves left with it; timed items starting inside it collapse onto the cut.
  const shift = (t: number): number => (t >= b ? t - len : t > a ? a : t);
  d.video = rippleDelete(d.video, id);
  const total = totalDuration(d.video);
  d.zooms = d.zooms.filter((z) => !(z.t > a && z.t < b)); // keyframes inside the removed footage go with it
  for (const z of d.zooms) z.t = shift(z.t);
  for (const it of [...d.broll, ...d.audio, ...d.texts]) it.start = shift(it.start);
  d.zooms = d.zooms.filter((z) => z.t <= total);
};

/** Trim one edge, never past a neighbouring piece in source order (that would duplicate footage). */
export const trimPieceEdge = (id: string, edge: "start" | "end", newSrc: number, bounds: { min: number; max: number }): Recipe => (d) => {
  const i = d.video.findIndex((x) => x.id === id);
  if (i < 0) return;
  const p = d.video[i]!;
  const prev = d.video[i - 1];
  const next = d.video[i + 1];
  const b = { ...bounds };
  if (edge === "start" && prev && prev.srcEnd <= p.srcStart) b.min = Math.max(b.min, prev.srcEnd);
  if (edge === "end" && next && next.srcStart >= p.srcEnd) b.max = Math.min(b.max, next.srcStart);
  d.video = trimPiece(d.video, id, edge, newSrc, b, MIN_PIECE_SEC);
};

export const setTransition = (id: string, type: TransitionType, durationSec = 0.4): Recipe => (d) => {
  const p = d.video.find((x) => x.id === id);
  if (!p) return;
  if (type === "none") delete p.transitionIn;
  else p.transitionIn = { type, durationSec: clampNum(durationSec, 0.1, 2) };
};

// ── zoom keyframes ──────────────────────────────────────────────────────
export const addZoomKey = (key: ZoomKey): Recipe => (d) => {
  d.zooms.push(key);
  d.zooms.sort((a, b) => a.t - b.t);
};
export const updateZoomKey = (id: string, patch: Partial<Omit<ZoomKey, "id">>): Recipe => (d) => {
  const z = d.zooms.find((x) => x.id === id);
  if (!z) return;
  if (patch.t !== undefined) z.t = clampNum(patch.t, 0, Math.max(0, totalDuration(d.video)));
  if (patch.scale !== undefined) z.scale = clampNum(patch.scale, 1, 3);
  if (patch.ease !== undefined) z.ease = patch.ease;
  d.zooms.sort((a, b) => a.t - b.t);
};
export const removeZoomKey = (id: string): Recipe => (d) => {
  d.zooms = d.zooms.filter((z) => z.id !== id);
};

export const setLook = (look: LookId): Recipe => (d) => {
  d.look = look;
};

// ── captions ────────────────────────────────────────────────────────────
export const setCaptionsEnabled = (on: boolean): Recipe => (d) => {
  d.captions.enabled = on;
};
export const setCaptionStyle = (styleId: string, keepOverrides = false): Recipe => (d) => {
  d.captions.styleId = styleId;
  if (!keepOverrides) d.captions.overrides = {};
};
export const setCaptionOverride = <K extends keyof CaptionStyle>(key: K, value: CaptionStyle[K] | undefined): Recipe => (d) => {
  const o = d.captions.overrides as Record<string, unknown>;
  if (value === undefined) delete o[key];
  else o[key] = value;
};
export const resetCaptionOverrides = (): Recipe => (d) => {
  d.captions.overrides = {};
};

export const editWord = (id: string, text: string): Recipe => (d) => {
  d.captions.words = editWordText(d.captions.words, id, text);
};
export const toggleWordEmphasis = (id: string): Recipe => (d) => {
  const w = d.captions.words.find((x) => x.id === id);
  if (w) w.emph = w.emph ? undefined : true;
};
export const toggleWordHidden = (id: string): Recipe => (d) => {
  const w = d.captions.words.find((x) => x.id === id);
  if (w) w.hidden = w.hidden ? undefined : true;
};
export const setWordEmoji = (id: string, emoji: string | undefined): Recipe => (d) => {
  const w = d.captions.words.find((x) => x.id === id);
  if (w) w.emoji = emoji && emoji.trim() ? emoji.trim() : undefined;
};
/** Replace emphasis with the offline heuristic; adds emoji when the active style shows them. */
export const autoEmphasise = (customStyles: CaptionStyle[] = []): Recipe => (d) => {
  const style = resolveCaptionStyle(d.captions.styleId, d.captions.overrides as Partial<CaptionStyle>, customStyles);
  const words = d.captions.words;
  const pick = heuristicEmphasis(words);
  words.forEach((w, i) => {
    const on = pick.has(i);
    w.emph = on ? true : undefined;
    if (on && style.emoji && !w.emoji) w.emoji = emojiFor(w.w);
  });
};

// ── b-roll / audio / text ───────────────────────────────────────────────
export const addBroll = (item: BrollItem): Recipe => (d) => {
  d.broll.push(item);
};
export const updateBroll = (id: string, patch: Partial<Omit<BrollItem, "id">>): Recipe => (d) => {
  const it = d.broll.find((x) => x.id === id);
  if (it) Object.assign(it, sanitiseTimed(patch));
};
export const removeBroll = (id: string): Recipe => (d) => {
  d.broll = d.broll.filter((x) => x.id !== id);
};

export const addAudio = (item: AudioItem): Recipe => (d) => {
  d.audio.push(item);
};
export const updateAudio = (id: string, patch: Partial<Omit<AudioItem, "id">>): Recipe => (d) => {
  const it = d.audio.find((x) => x.id === id);
  if (it) Object.assign(it, sanitiseTimed(patch));
};
export const removeAudio = (id: string): Recipe => (d) => {
  d.audio = d.audio.filter((x) => x.id !== id);
};

export const addText = (item: TextItem): Recipe => (d) => {
  d.texts.push(item);
};
export const updateText = (id: string, patch: Partial<Omit<TextItem, "id">>): Recipe => (d) => {
  const it = d.texts.find((x) => x.id === id);
  if (!it) return;
  const p = { ...sanitiseTimed(patch) } as Partial<TextItem>;
  if (p.x !== undefined) p.x = clampNum(p.x, 0, 1);
  if (p.y !== undefined) p.y = clampNum(p.y, 0, 1);
  Object.assign(it, p);
};
export const removeText = (id: string): Recipe => (d) => {
  d.texts = d.texts.filter((x) => x.id !== id);
};

function sanitiseTimed<T extends { start?: number; duration?: number; volume?: number; srcOffset?: number }>(p: T): T {
  const out = { ...p };
  if (out.start !== undefined) out.start = Math.max(0, out.start);
  if (out.duration !== undefined) out.duration = Math.max(MIN_ITEM_SEC, out.duration);
  if (out.volume !== undefined) out.volume = clampNum(out.volume, 0, 2);
  if (out.srcOffset !== undefined) out.srcOffset = Math.max(0, out.srcOffset);
  return out;
}

// ── overlays / global ───────────────────────────────────────────────────
export const setHook = (patch: Partial<EditState["hook"]>): Recipe => (d) => {
  Object.assign(d.hook, patch);
  d.hook.durationSec = clampNum(d.hook.durationSec, 0.5, 10);
};
export const setProgressBar = (patch: Partial<EditState["progressBar"]>): Recipe => (d) => {
  Object.assign(d.progressBar, patch);
};
export const setSafeZone = (zone: Provider | "none"): Recipe => (d) => {
  d.safeZone = zone;
};
export const setVolume = (v: number): Recipe => (d) => {
  d.volume = clampNum(v, 0, 2);
};
export const setDuckLevel = (v: number): Recipe => (d) => {
  d.duckLevel = clampNum(v, 0, 1);
};

export const presetIds = (): string[] => CAPTION_PRESETS.map((p) => p.id);
