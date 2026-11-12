import fs from "node:fs";
import { z } from "zod";
import type { Clip, SourceVideo, Word } from "@klipz/shared";
import { run, tx, nowIso } from "./db";
import { HttpError } from "./http";
import { enqueueJob } from "./jobs";
import { storagePath } from "./paths";
import { getClip, getSource, getTranscript } from "./repo";

export const MIN_CLIP_SEC = 1;
export const MAX_CLIP_SEC = 180;
/** Transcript padding returned with a clip so the trim control has words to snap to. */
export const WORD_PAD_SEC = 2;

/** Body of PATCH /api/clips/:id. */
export const ClipPatchSchema = z
  .object({
    status: z.enum(["candidate", "kept", "discarded"]).optional(),
    start_sec: z.number().finite().optional(),
    end_sec: z.number().finite().optional(),
    title: z.string().max(200).nullable().optional(),
    hook: z.string().max(300).nullable().optional(),
    caption_style_id: z.string().max(64).nullable().optional(),
    edit_state: z.object({ version: z.literal(1) }).passthrough().nullable().optional(),
    expected_version: z.number().int().min(0).optional(),
  })
  .strict();
export type ClipPatch = z.infer<typeof ClipPatchSchema>;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface ClipPlan {
  /** column → new value (objects are JSON-encoded when written) */
  columns: Record<string, unknown>;
  rangeChanged: boolean;
  bumpVersion: boolean;
}

/**
 * Pure validation: decides what a PATCH changes without touching the database.
 * Throws HttpError(400) for impossible ranges and HttpError(409) for stale edits.
 */
export function planClipPatch(clip: Pick<Clip, "start_sec" | "end_sec" | "edit_version">, durationSec: number | null, patch: ClipPatch): ClipPlan {
  const columns: Record<string, unknown> = {};
  let rangeChanged = false;

  if (patch.expected_version !== undefined && patch.expected_version !== clip.edit_version) {
    throw new HttpError(409, `Clip was changed elsewhere (version ${clip.edit_version}, you had ${patch.expected_version})`);
  }

  for (const k of ["status", "title", "hook", "caption_style_id"] as const) {
    if (patch[k] !== undefined) columns[k] = patch[k];
  }

  if (patch.start_sec !== undefined || patch.end_sec !== undefined) {
    const max = durationSec != null && durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY;
    const start = round3(clamp(patch.start_sec ?? clip.start_sec, 0, max));
    const end = round3(clamp(patch.end_sec ?? clip.end_sec, 0, max));
    const len = end - start;
    if (len < MIN_CLIP_SEC - 1e-6) throw new HttpError(400, `Clip must be at least ${MIN_CLIP_SEC} s long`);
    if (len > MAX_CLIP_SEC + 1e-6) throw new HttpError(400, `Clip can be at most ${MAX_CLIP_SEC} s long`);
    if (Math.abs(start - clip.start_sec) > 1e-6 || Math.abs(end - clip.end_sec) > 1e-6) {
      columns.start_sec = start;
      columns.end_sec = end;
      columns.crop_track = null; // the framing belongs to the old range
      // An automatic Smart Edit nobody touched (version 0) was cut for the old range too: drop it, the
      // reframe job that follows rebuilds it for the new range. A person's own edit is never discarded.
      if (clip.edit_version === 0 && patch.edit_state === undefined) columns.edit_state = null;
      rangeChanged = true;
    }
  }

  const bumpVersion = patch.edit_state !== undefined;
  if (bumpVersion) columns.edit_state = patch.edit_state;
  return { columns, rangeChanged, bumpVersion };
}

const WRITABLE = new Set(["status", "title", "hook", "caption_style_id", "edit_state", "start_sec", "end_sec", "crop_track"]);

/** Apply a validated PATCH atomically; enqueues a reframe job when the range changed. */
export function applyClipPatch(clipId: string, patch: ClipPatch): { clip: Clip; reframeQueued: boolean } {
  const out = tx(() => {
    const clip = getClip(clipId);
    if (!clip) throw new HttpError(404, "Clip not found");
    const source = getSource(clip.source_video_id);
    const plan = planClipPatch(clip, source?.duration_sec ?? null, patch);
    const keys = Object.keys(plan.columns).filter((k) => WRITABLE.has(k));
    if (keys.length > 0) {
      const vals = keys.map((k) => {
        const v = plan.columns[k];
        if (v === null || v === undefined) return null;
        return typeof v === "object" ? JSON.stringify(v) : (v as string | number);
      });
      const sets = keys.map((k) => `${k} = ?`);
      if (plan.bumpVersion) sets.push("edit_version = edit_version + 1");
      sets.push("updated_at = ?");
      run(`update clips set ${sets.join(", ")} where id = ?`, ...vals, nowIso(), clipId);
    }
    return { clip: getClip(clipId)!, reframeQueued: plan.rangeChanged };
  });
  // enqueueJob opens its own transaction, so it must run after ours committed.
  if (out.reframeQueued) {
    const opts = { projectId: out.clip.project_id };
    const job = enqueueJob("reframe", { clip_id: clipId, force: true }, { ...opts, dedupeKey: `reframe:${clipId}` });
    // A reframe already running started from the old range; queue one more behind it so the new range is framed too.
    if (job.status === "running") enqueueJob("reframe", { clip_id: clipId, force: true }, { ...opts, dedupeKey: `reframe:${clipId}:next` });
  }
  return out;
}

/** Words overlapping [start - pad, end + pad]. */
export function wordsInRange(words: Word[], from: number, to: number): Word[] {
  return words.filter((w) => w.e > from && w.s < to);
}

export function clipDetail(clipId: string): { clip: Clip; source: SourceVideo | null; words: Word[] } | undefined {
  const clip = getClip(clipId);
  if (!clip) return undefined;
  const source = getSource(clip.source_video_id) ?? null;
  const t = getTranscript(clip.source_video_id);
  const words = t ? wordsInRange(t.words ?? [], clip.start_sec - WORD_PAD_SEC, clip.end_sec + WORD_PAD_SEC) : [];
  return { clip, source, words };
}

/** Delete the clip row (renders/posts cascade) and its stored files. */
export function deleteClip(clipId: string): boolean {
  const r = run("delete from clips where id = ?", clipId);
  if (r.changes === 0) return false;
  // Queued work for a clip that no longer exists would only fail in the worker.
  run(
    "update jobs set status = 'cancelled', finished_at = ?, updated_at = ? where status = 'queued' and json_extract(payload, '$.clip_id') = ?",
    nowIso(),
    nowIso(),
    clipId,
  );
  fs.rmSync(storagePath(`clips/${clipId}`), { recursive: true, force: true });
  return true;
}
