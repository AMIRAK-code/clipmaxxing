import { z } from "zod";
import { body, HttpError, ok, route } from "@/server/http";
import { enqueueJob } from "@/server/jobs";
import { openFolder } from "@/server/library";
import { manualFiles, planVideos, requireProject, setEngine } from "@/server/manual-ai";

export const dynamic = "force-dynamic";

/** The files made for Gemini so far (empty until the export job has run). */
export const GET = route<{ id: string }>((_req, { id }) => {
  requireProject(id);
  const { files } = manualFiles(id);
  return ok({ files });
});

const Action = z.object({ action: z.enum(["export", "open"]) });

/**
 * export: switch the project to Manual AI Mode and make the transcript, light video(s) and prompt.
 * open:   show the folder with those files in Explorer (Windows app).
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const { action } = await body(req, Action);
  const project = requireProject(id);
  if (action === "open") {
    const { folder, files } = manualFiles(id);
    if (!files.length) throw new HttpError(409, "The files are not ready yet");
    await openFolder(folder);
    return ok({ folder });
  }
  const videos = planVideos(id);
  if (!videos.length) throw new HttpError(400, "Add a video first");
  setEngine(project, "manual");
  const job = enqueueJob("manual_export", { project_id: id }, { projectId: id, dedupeKey: `manual_export:${id}` });
  return ok({ job });
});
