import type { MontageScene, VideoPiece } from "@klipz/shared";

/** The pool scene a montage piece is cut from (its start lies inside the scene's footage). */
export function sceneForPiece(scenes: MontageScene[], piece: Pick<VideoPiece, "srcStart">): MontageScene | undefined {
  return scenes.find((s) => s.pool_min - 1e-3 <= piece.srcStart && piece.srcStart < s.pool_max);
}

/** Trim limits of a montage piece: its scene with the extra footage around it, so it never runs into
 * the next scene of the pool (another upload). Pieces of other clips use `fallback`. */
export function pieceTrimBounds(
  scenes: MontageScene[] | null | undefined,
  piece: Pick<VideoPiece, "srcStart">,
  fallback: { min: number; max: number },
): { min: number; max: number } {
  const s = scenes ? sceneForPiece(scenes, piece) : undefined;
  return s ? { min: s.pool_min, max: s.pool_max } : fallback;
}
