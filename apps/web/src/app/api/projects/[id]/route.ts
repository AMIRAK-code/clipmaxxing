import fs from "node:fs";
import { z } from "zod";
import { run, update } from "@/server/db";
import { body, notFound, ok, route } from "@/server/http";
import { jobsForProject } from "@/server/jobs";
import { storagePath } from "@/server/paths";
import { latestRenderByClip } from "@/server/renders";
import { clipsForProject, getProject, montageInputs, sourceForProject, sourcesOfProject } from "@/server/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>((_req, { id }) => {
  const project = getProject(id) ?? notFound();
  return ok({
    project,
    source: sourceForProject(id) ?? null,
    inputs: project.kind === "montage" ? montageInputs(id) : undefined,
    clips: clipsForProject(id),
    jobs: jobsForProject(id, 20),
    renders: latestRenderByClip(id),
  });
});

export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const patch = await body(req, z.object({ title: z.string().min(1).max(160) }));
  if (!update("projects", id, patch, ["title"])) notFound();
  return ok({ project: getProject(id) });
});

/**
 * Remove a storage folder without blocking the request. Windows refuses to delete a file that is still
 * open (ffmpeg importing it, the page previewing it), so retry for a few seconds; anything still left is
 * swept by the worker's daily cleanup. A failed delete of files must never fail the project delete.
 */
function removeDir(key: string): void {
  fs.promises
    .rm(storagePath(key), { recursive: true, force: true, maxRetries: 8, retryDelay: 400 })
    .catch((e: unknown) => console.warn(`[projects] could not remove ${key} yet: ${e instanceof Error ? e.message : String(e)}`));
}

/** Delete a project and every file that belongs to it. */
export const DELETE = route<{ id: string }>((_req, { id }) => {
  getProject(id) ?? notFound();
  const dirs = new Set<string>();
  for (const s of sourcesOfProject(id)) dirs.add(`sources/${s.id}`); // a montage has several

  for (const c of clipsForProject(id)) dirs.add(`clips/${c.id}`);
  // Jobs go with the project (cascade); the worker notices its job is gone at its next progress step.
  run("delete from projects where id = ?", id);
  for (const d of dirs) removeDir(d);
  return ok({ deleted: true });
});
