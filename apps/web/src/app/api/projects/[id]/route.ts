import fs from "node:fs";
import { z } from "zod";
import { run, update } from "@/server/db";
import { body, notFound, ok, route } from "@/server/http";
import { jobsForProject } from "@/server/jobs";
import { storagePath } from "@/server/paths";
import { latestRenderByClip } from "@/server/renders";
import { clipsForProject, getProject, sourceForProject } from "@/server/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>((_req, { id }) => {
  const project = getProject(id) ?? notFound();
  return ok({ project, source: sourceForProject(id) ?? null, clips: clipsForProject(id), jobs: jobsForProject(id, 20), renders: latestRenderByClip(id) });
});

export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const patch = await body(req, z.object({ title: z.string().min(1).max(160) }));
  if (!update("projects", id, patch, ["title"])) notFound();
  return ok({ project: getProject(id) });
});

/** Delete a project and every file that belongs to it. */
export const DELETE = route<{ id: string }>((_req, { id }) => {
  getProject(id) ?? notFound();
  const source = sourceForProject(id);
  const dirs = new Set<string>();
  if (source) dirs.add(`sources/${source.id}`);
  for (const c of clipsForProject(id)) dirs.add(`clips/${c.id}`);
  run("delete from projects where id = ?", id);
  for (const d of dirs) fs.rmSync(storagePath(d), { recursive: true, force: true });
  return ok({ deleted: true });
});
