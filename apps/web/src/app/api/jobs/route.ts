import { z } from "zod";
import { body, HttpError, ok, route } from "@/server/http";
import { deadLetterJobs, enqueueJob } from "@/server/jobs";
import { getClip, getSource } from "@/server/repo";

export const dynamic = "force-dynamic";

const Enqueue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("analyze"), sourceVideoId: z.string().uuid(), maxClips: z.number().int().min(1).max(30).optional() }),
  z.object({
    type: z.literal("autoclip"),
    sourceVideoId: z.string().uuid(),
    maxClips: z.number().int().min(1).max(30).optional(),
    styleId: z.string().max(64).optional(),
  }),
  z.object({ type: z.literal("reframe"), clipId: z.string().uuid() }),
  z.object({ type: z.literal("ingest"), sourceVideoId: z.string().uuid() }),
]);

/** Queue pipeline work. Dedupe keys make double-clicks harmless. */
export const POST = route(async (req) => {
  const input = await body(req, Enqueue);
  if (input.type === "reframe") {
    const clip = getClip(input.clipId);
    if (!clip) throw new HttpError(404, "Clip not found");
    return ok({ job: enqueueJob("reframe", { clip_id: clip.id, force: true }, { projectId: clip.project_id, dedupeKey: `reframe:${clip.id}` }) });
  }
  const source = getSource(input.sourceVideoId);
  if (!source) throw new HttpError(404, "Source video not found");
  if (source.status === "deleted") throw new HttpError(410, "The source file was cleaned up; re-import it first");
  const payload: Record<string, unknown> = { source_video_id: source.id };
  if ("maxClips" in input && input.maxClips) payload.max_clips = input.maxClips;
  if (input.type === "autoclip" && input.styleId) payload.style_id = input.styleId;
  if (input.type === "analyze") payload.force = true;
  const job = enqueueJob(input.type, payload, { projectId: source.project_id, dedupeKey: `${input.type}:${source.id}` });
  return ok({ job });
});

/** Dead-letter queue: jobs that ran out of retries. */
export const GET = route(() => ok({ jobs: deadLetterJobs() }));
