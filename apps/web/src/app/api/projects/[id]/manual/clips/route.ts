import { z } from "zod";
import { body, HttpError, ok, route } from "@/server/http";
import { enqueueJob } from "@/server/jobs";
import { parsePlan, PlanError } from "@/lib/gemini-plan";
import { planVideos, requireProject } from "@/server/manual-ai";

export const dynamic = "force-dynamic";

/** Parse the JSON pasted from Gemini and queue the clips it describes (cut from the original videos). */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const { json } = await body(req, z.object({ json: z.string().max(500_000) }));
  requireProject(id);
  let plan;
  try {
    plan = parsePlan(json, planVideos(id));
  } catch (e) {
    if (e instanceof PlanError) throw new HttpError(400, e.message);
    throw e;
  }
  // no dedupe key: pasting a second answer while the first is still being cut is a new batch of clips
  const job = enqueueJob("manual_clips", { project_id: id, clips: plan.clips }, { projectId: id });
  return ok({ job, clips: plan.clips.length, warnings: plan.warnings });
});
