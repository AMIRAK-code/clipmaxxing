import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { createProject, listProjects } from "@/server/repo";
import { MontageSettings } from "@/lib/montage";

export const dynamic = "force-dynamic";

export const GET = route(() => ok({ projects: listProjects("montage") }));

const Create = MontageSettings.extend({ title: z.string().max(160).optional() });

/** Create an empty montage project; the browser then uploads its videos to it (/api/uploads with projectId)
 * and starts the job with POST /api/montages/[id]. */
export const POST = route(async (req) => {
  const input = await body(req, Create);
  const project = createProject(input.title?.trim() || "Montage", "montage", {
    count: input.count,
    minSec: input.minSec,
    maxSec: Math.max(input.minSec, input.maxSec),
  });
  return ok({ project }, { status: 201 });
});
