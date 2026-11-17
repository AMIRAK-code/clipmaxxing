import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { createMontageProject, listMontageProjects } from "@/server/montage";

export const dynamic = "force-dynamic";

export const GET = route(() => ok({ projects: listMontageProjects() }));

const Settings = z.object({
  count: z.number().int().min(1).max(20).optional(),
  minSec: z.number().min(5).max(60).optional(),
  maxSec: z.number().min(5).max(60).optional(),
});
const Create = z.object({ title: z.string().max(160).optional(), settings: Settings.default({}) });

/** Create an empty montage project; the videos are then uploaded with its id (POST /api/uploads). */
export const POST = route(async (req) => {
  const input = await body(req, Create);
  const project = createMontageProject(input.title?.trim() || "Montage", input.settings);
  return ok({ project }, { status: 201 });
});
