import type { CropTrack, Job } from "@klipz/shared";

/** True when this job row is a reframe of the given clip that just finished successfully. */
export function isFinishedReframeFor(job: Pick<Job, "type" | "status" | "payload">, clipId: string): boolean {
  return job.type === "reframe" && job.status === "succeeded" && (job.payload as { clip_id?: string } | null)?.clip_id === clipId;
}

/**
 * Pick the crop track out of a GET /api/clips/:id body. Only the crop track is ever taken from the
 * server: the edit (captions, trims, ...) stays whatever is in the editor, so unsaved edits are never clobbered.
 */
export function cropTrackFromClipResponse(body: unknown): CropTrack | null | undefined {
  const clip = (body as { clip?: { crop_track?: CropTrack | null } } | null)?.clip;
  return clip && "crop_track" in clip ? (clip.crop_track ?? null) : undefined;
}
