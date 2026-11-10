import type { CaptionStyle, EditState, LookId, Provider, VideoPiece, Word } from "./types";
import { uid, wordsToCaptionWords } from "./timeline";
import { emojiFor, heuristicEmphasis } from "./captions";

const base: Omit<CaptionStyle, "id" | "name"> = {
  fontFamily: "Montserrat",
  fontWeight: 900,
  fontSize: 84,
  uppercase: true,
  letterSpacing: 0,
  lineHeight: 1.08,
  color: "#FFFFFF",
  activeColor: "#FFE600",
  emphasisColor: "#39FF14",
  highlight: "color",
  boxColor: "#7C3AED",
  boxRadius: 14,
  strokeColor: "#000000",
  strokeWidth: 10,
  shadow: "0 6px 0 rgba(0,0,0,0.55)",
  pageBackground: "transparent",
  pagePadding: 0,
  anim: "pop",
  wordsPerPage: 3,
  maxCharsPerLine: 16,
  position: 0.68,
  emoji: false,
};

/** The 8 built-in caption looks. Stored as plain JSON so users can clone/tweak them. */
export const CAPTION_PRESETS: CaptionStyle[] = [
  { ...base, id: "bold-outline", name: "Bold Outline" },
  {
    ...base,
    id: "karaoke-neon",
    name: "Karaoke Neon",
    fontFamily: "Poppins",
    fontWeight: 800,
    color: "rgba(255,255,255,0.45)",
    activeColor: "#00F0FF",
    emphasisColor: "#FF2BD6",
    highlight: "karaoke",
    strokeWidth: 0,
    shadow: "0 0 18px rgba(0,240,255,0.9), 0 0 44px rgba(0,240,255,0.55)",
    anim: "fade",
    wordsPerPage: 4,
    maxCharsPerLine: 18,
    fontSize: 78,
  },
  {
    ...base,
    id: "yellow-highlight",
    name: "Yellow Highlight",
    fontFamily: "Archivo Black",
    fontWeight: 400,
    color: "#FFFFFF",
    activeColor: "#111111",
    highlight: "box",
    boxColor: "#FFD60A",
    strokeWidth: 0,
    shadow: "0 4px 14px rgba(0,0,0,0.6)",
    anim: "pop",
    fontSize: 76,
  },
  {
    ...base,
    id: "minimal",
    name: "Minimal",
    fontFamily: "Inter",
    fontWeight: 700,
    uppercase: false,
    color: "#FFFFFF",
    activeColor: "#FFFFFF",
    emphasisColor: "#FFFFFF",
    highlight: "none",
    strokeWidth: 0,
    shadow: "0 2px 10px rgba(0,0,0,0.75)",
    anim: "fade",
    wordsPerPage: 4,
    maxCharsPerLine: 24,
    fontSize: 58,
    position: 0.78,
  },
  {
    ...base,
    id: "comic-pop",
    name: "Comic Pop",
    fontFamily: "Bangers",
    fontWeight: 400,
    letterSpacing: 0.03,
    color: "#FFFFFF",
    activeColor: "#FF3B30",
    emphasisColor: "#FFD60A",
    highlight: "scale",
    strokeWidth: 12,
    shadow: "6px 6px 0 #000000",
    anim: "bounce",
    wordsPerPage: 2,
    fontSize: 104,
    emoji: true,
  },
  {
    ...base,
    id: "one-word-punch",
    name: "One-Word Punch",
    fontFamily: "Anton",
    fontWeight: 400,
    color: "#FFFFFF",
    activeColor: "#FFFFFF",
    emphasisColor: "#FF3B30",
    highlight: "none",
    strokeWidth: 8,
    shadow: "0 8px 0 rgba(0,0,0,0.6)",
    anim: "pop",
    wordsPerPage: 1,
    fontSize: 136,
    position: 0.6,
  },
  {
    ...base,
    id: "boxed-subtitle",
    name: "Boxed Subtitle",
    fontFamily: "Inter",
    fontWeight: 700,
    uppercase: false,
    color: "#FFFFFF",
    activeColor: "#FDE047",
    emphasisColor: "#FDE047",
    highlight: "color",
    strokeWidth: 0,
    shadow: "none",
    pageBackground: "rgba(0,0,0,0.72)",
    pagePadding: 22,
    anim: "slide-up",
    wordsPerPage: 4,
    maxCharsPerLine: 22,
    fontSize: 54,
    position: 0.8,
  },
  {
    ...base,
    id: "gradient-glow",
    name: "Purple Glow",
    fontFamily: "Bebas Neue",
    fontWeight: 400,
    letterSpacing: 0.02,
    color: "#F5F3FF",
    activeColor: "#C084FC",
    emphasisColor: "#F472B6",
    highlight: "scale",
    strokeWidth: 6,
    strokeColor: "#1E1B4B",
    shadow: "0 0 24px rgba(192,132,252,0.85)",
    anim: "bounce",
    wordsPerPage: 3,
    fontSize: 100,
    emoji: true,
  },
];

export const DEFAULT_CAPTION_STYLE_ID = "bold-outline";

/** Font files expected under /fonts (self-hosted, copied by scripts/copy-fonts.mjs). */
export const FONT_FILES: Record<string, { file: string; weight: number }[]> = {
  Montserrat: [{ file: "montserrat-900.woff2", weight: 900 }],
  Poppins: [{ file: "poppins-800.woff2", weight: 800 }],
  Inter: [{ file: "inter-700.woff2", weight: 700 }],
  "Archivo Black": [{ file: "archivo-black-400.woff2", weight: 400 }],
  Bangers: [{ file: "bangers-400.woff2", weight: 400 }],
  Anton: [{ file: "anton-400.woff2", weight: 400 }],
  "Bebas Neue": [{ file: "bebas-neue-400.woff2", weight: 400 }],
};

export function resolveCaptionStyle(
  styleId: string,
  overrides: Partial<CaptionStyle> = {},
  custom: CaptionStyle[] = [],
): CaptionStyle {
  const found =
    custom.find((s) => s.id === styleId) ?? CAPTION_PRESETS.find((s) => s.id === styleId) ?? CAPTION_PRESETS[0]!;
  return { ...found, ...overrides };
}

/** "LUT-style" looks, implemented as CSS filter chains so preview == render. */
export const LOOKS: Record<LookId, { name: string; filter: string }> = {
  none: { name: "None", filter: "none" },
  warm: { name: "Warm", filter: "sepia(0.22) saturate(1.25) contrast(1.05) brightness(1.03)" },
  cool: { name: "Cool", filter: "hue-rotate(-12deg) saturate(1.1) contrast(1.06) brightness(1.02)" },
  cinematic: { name: "Cinematic", filter: "contrast(1.18) saturate(0.88) brightness(0.96) sepia(0.12)" },
  bw: { name: "B&W", filter: "grayscale(1) contrast(1.2)" },
  vivid: { name: "Vivid", filter: "saturate(1.55) contrast(1.12)" },
  fade: { name: "Faded", filter: "contrast(0.88) saturate(0.85) brightness(1.08)" },
};

export interface SafeZone {
  /** fractions of the frame that platform UI covers */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Approximate UI-overlay margins for 9:16 video on each platform. */
export const SAFE_ZONES: Record<Provider, SafeZone> = {
  tiktok: { top: 0.11, bottom: 0.25, left: 0.04, right: 0.16 },
  instagram: { top: 0.13, bottom: 0.27, left: 0.05, right: 0.14 },
  youtube: { top: 0.1, bottom: 0.24, left: 0.04, right: 0.16 },
  facebook: { top: 0.13, bottom: 0.27, left: 0.05, right: 0.14 },
  x: { top: 0.06, bottom: 0.12, left: 0.04, right: 0.04 },
  linkedin: { top: 0.06, bottom: 0.12, left: 0.04, right: 0.04 },
};

/** Clamp a caption's vertical position so it stays clear of the platform UI. */
export function clampToSafeZone(position: number, zone: SafeZone | null, blockHeightFrac = 0.12): number {
  if (!zone) return position;
  const min = zone.top + blockHeightFrac / 2;
  const max = 1 - zone.bottom - blockHeightFrac / 2;
  return Math.min(Math.max(position, min), max);
}

/** The edit a fresh clip starts with: one piece, default captions, hook card off. */
export function createDefaultEditState(args: {
  start: number;
  end: number;
  words: Word[];
  hook?: string | null;
  styleId?: string;
  keywords?: string[];
}): EditState {
  const styleId = args.styleId ?? DEFAULT_CAPTION_STYLE_ID;
  const style = resolveCaptionStyle(styleId);
  let words = wordsToCaptionWords(args.words, args.start, args.end);
  const emph = args.keywords?.length
    ? new Set(
        words
          .map((w, i) => (args.keywords!.some((k) => k.toLowerCase() === w.w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "")) ? i : -1))
          .filter((i) => i >= 0),
      )
    : heuristicEmphasis(words);
  words = words.map((w, i) => (emph.has(i) ? { ...w, emph: true, emoji: style.emoji ? emojiFor(w.w) : undefined } : w));
  const piece: VideoPiece = { id: uid("v"), srcStart: args.start, srcEnd: args.end };
  return {
    version: 1,
    video: [piece],
    captions: { enabled: true, styleId, overrides: {}, words },
    broll: [],
    audio: [],
    texts: [],
    zooms: [],
    look: "none",
    hook: { enabled: false, text: args.hook ?? "", durationSec: 3 },
    progressBar: { enabled: false, color: "#FFE600", position: "bottom", height: 10 },
    volume: 1,
    duckLevel: 0.25,
    safeZone: "tiktok",
  };
}
