import { Easing, interpolate, spring } from "remotion";
import type { CaptionAnim, TransitionType } from "@klipz/shared";

export interface Entrance {
  opacity: number;
  scale: number;
  /** px, positive = down */
  translateY: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Entrance animation of a caption page / text item. `frame` is frames since the
 * element appeared (may be negative = not yet visible).
 */
export function entrance(anim: CaptionAnim, frame: number, fps: number): Entrance {
  const f = Math.max(0, frame);
  switch (anim) {
    case "none":
      return { opacity: 1, scale: 1, translateY: 0 };
    case "pop": {
      const d = Math.max(1, Math.round(fps * 0.2));
      const k = clamp01(f / d);
      return {
        opacity: clamp01(f / Math.max(1, d / 2)),
        scale: interpolate(k, [0, 1], [0.6, 1], { easing: Easing.out(Easing.back(2.2)) }),
        translateY: 0,
      };
    }
    case "bounce": {
      const s = spring({ frame: f, fps, config: { damping: 9, stiffness: 220, mass: 0.7 } });
      return { opacity: clamp01(f / 2), scale: 0.4 + 0.6 * s, translateY: (1 - s) * 40 };
    }
    case "fade": {
      const d = Math.max(1, Math.round(fps * 0.2));
      return { opacity: clamp01(f / d), scale: 1, translateY: 0 };
    }
    case "slide-up": {
      const d = Math.max(1, Math.round(fps * 0.25));
      const k = Easing.out(Easing.cubic)(clamp01(f / d));
      return { opacity: clamp01(f / Math.max(1, d / 2)), scale: 1, translateY: (1 - k) * 70 };
    }
  }
}

export interface TransitionStyle {
  opacity: number;
  /** px */
  translateX: number;
  scale: number;
  /** opacity of a white overlay (flash) */
  flash: number;
}

/** Look of a piece `progress` (0..1) of the way through its incoming transition. */
export function transitionStyle(type: TransitionType | undefined, progress: number, width = 1080): TransitionStyle {
  const p = clamp01(progress);
  const idle: TransitionStyle = { opacity: 1, translateX: 0, scale: 1, flash: 0 };
  switch (type) {
    case undefined:
    case "none":
      return idle;
    case "fade":
      return { ...idle, opacity: p };
    case "slide":
      return { ...idle, translateX: (1 - Easing.out(Easing.cubic)(p)) * width };
    case "zoom":
      return { ...idle, opacity: clamp01(p * 2), scale: 1.3 - 0.3 * Easing.out(Easing.cubic)(p) };
    case "flash":
      return { ...idle, flash: 1 - p };
  }
}

/** Fraction of the entrance/exit envelope for the hook card (0 -> 1 -> 0). */
export function hookEnvelope(frame: number, durationFrames: number, fps: number): number {
  const edge = Math.min(Math.round(fps * 0.3), Math.floor(durationFrames / 2));
  if (edge <= 0) return 1;
  const inK = clamp01(frame / edge);
  const outK = clamp01((durationFrames - frame) / edge);
  return Math.min(inK, outK);
}
