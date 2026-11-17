import type { MontageScene, VideoPiece } from "@klipz/shared";
import { z } from "zod";
import type { Recipe } from "@/lib/editor/ops";

/** How many montages and how long each one is (seconds). */
export const MontageSettings = z.object({
  count: z.number().int().min(1).max(20),
  minSec: z.number().min(3).max(120),
  maxSec: z.number().min(3).max(180),
});
export type MontageSettings = z.infer<typeof MontageSettings>;

export const MONTAGE_DEFAULTS: MontageSettings = { count: 3, minSec: 10, maxSec: 20 };

/** The pool scene a piece was taken from (pieces start inside their scene). */
export function sceneOfPiece(scenes: readonly MontageScene[], piece: Pick<VideoPiece, "srcStart">): MontageScene | undefined {
  const t = piece.srcStart + 0.01;
  return scenes.find((s) => s.s <= t && t < s.e);
}

let seq = 0;
const pieceId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

// ── editor steps (undoable recipes, like lib/editor/ops) ──────────────────

/** A new piece showing the whole of `scene`, after the piece `afterId` (or at the end). A scene of another
 * shape sits whole in the middle of the pool frame, so its piece crops the middle (as the worker does). */
export const addScene = (scene: MontageScene, afterId?: string | null): Recipe => (d) => {
  const at = afterId ? d.video.findIndex((p) => p.id === afterId) : -1;
  d.video.splice(at >= 0 ? at + 1 : d.video.length, 0, {
    id: pieceId(),
    srcStart: scene.s,
    srcEnd: scene.e,
    ...(scene.fit ? { frame: { layout: "crop" as const, cx: 0.5, cy: 0.5, zoom: 1 } } : {}),
  });
};

/** Move a piece one place earlier (-1) or later (+1). */
export const moveScene = (id: string, by: -1 | 1): Recipe => (d) => {
  const i = d.video.findIndex((p) => p.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= d.video.length) return;
  const [p] = d.video.splice(i, 1);
  d.video.splice(j, 0, p!);
};

/** Sound on / off for the whole video. Muting also drops the pieces' own levels (so nothing stays
 * audible); turning the sound back on restores 100 %. */
export const setMuted = (muted: boolean): Recipe => (d) => {
  if (muted) {
    d.volume = 0;
    for (const p of d.video) delete p.volume;
  } else if (!(d.volume > 0)) {
    d.volume = 1;
  }
};

/** Is the video silent? */
export const isMuted = (edit: { volume: number; video: readonly Pick<VideoPiece, "volume">[] }): boolean =>
  edit.volume === 0 && edit.video.every((p) => p.volume === undefined || p.volume === 0);
