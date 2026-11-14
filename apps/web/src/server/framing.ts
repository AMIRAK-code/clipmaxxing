import type { Framing, SourceVideo } from "@klipz/shared";
import { all, run, tx } from "./db";
import { HttpError } from "./http";
import { enqueueJob } from "./jobs";
import { getSource } from "./repo";

/**
 * Change how a video's clips are made vertical:
 *   speaker  follow the person talking (face tracking)
 *   center   fill the screen with the middle of the picture (gameplay, screen recordings)
 *   fit      the whole picture over a blurred copy of itself
 *
 * Clips that already had a framing get a new one (their old track is dropped and a reframe job is
 * queued); clips that were never framed pick the new mode up when they are first rendered. A crop set
 * by hand in the editor is part of the clip's edit and is not touched.
 */
export function setSourceFraming(sourceId: string, framing: Framing): { source: SourceVideo; reframed: number } {
  const out = tx(() => {
    const source = getSource(sourceId);
    if (!source) throw new HttpError(404, "Source video not found");
    if (source.framing === framing) return { source, clips: [] as { id: string; project_id: string }[] };
    run("update source_videos set framing = ? where id = ?", framing, sourceId);
    const clips = all<{ id: string; project_id: string }>(
      "select id, project_id from clips where source_video_id = ? and crop_track is not null and status != 'discarded'",
      sourceId,
    );
    run("update clips set crop_track = null where source_video_id = ? and crop_track is not null", sourceId);
    return { source: getSource(sourceId)!, clips };
  });
  // enqueueJob opens its own transaction, so it runs after ours committed
  for (const c of out.clips) enqueueJob("reframe", { clip_id: c.id, force: true }, { projectId: c.project_id, dedupeKey: `reframe:${c.id}` });
  return { source: out.source, reframed: out.clips.length };
}
