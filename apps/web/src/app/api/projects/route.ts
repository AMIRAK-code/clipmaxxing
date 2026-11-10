import { z } from "zod";
import { body, HttpError, ok, route } from "@/server/http";
import { enqueueJob } from "@/server/jobs";
import { createProject, createSource, listProjects } from "@/server/repo";

export const dynamic = "force-dynamic";

const YOUTUBE_RE =
  /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

export const GET = route(() => ok({ projects: listProjects() }));

const Create = z.object({
  title: z.string().max(160).optional(),
  youtubeUrl: z.string().url().max(500),
  /** what to run once the download finishes */
  then: z.enum(["analyze", "autoclip"]).optional(),
});

/** Create a project from a YouTube URL. File uploads go through /api/uploads. */
export const POST = route(async (req) => {
  const input = await body(req, Create);
  if (!YOUTUBE_RE.test(input.youtubeUrl)) throw new HttpError(400, "That doesn't look like a YouTube video URL");
  const project = createProject(input.title?.trim() || "YouTube import");
  const source = createSource(project.id, { origin: "youtube", sourceUrl: input.youtubeUrl, status: "importing" });
  const job = enqueueJob(
    "import_youtube",
    { source_video_id: source.id, then: input.then },
    { projectId: project.id, dedupeKey: `import:${source.id}` },
  );
  return ok({ project, source, job }, { status: 201 });
});
