import path from "node:path";
import { z } from "zod";
import { run } from "@/server/db";
import { body, HttpError, ok, route } from "@/server/http";
import { createProject, createSource, getProject } from "@/server/repo";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 5 * 1024 ** 3; // 5 GB
const CHUNK_BYTES = 16 * 1024 ** 2;
const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);

const Start = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive(),
  projectId: z.string().uuid().optional(),
});

/** Begin a chunked upload: creates the project + source row and returns where to PUT chunks. */
export const POST = route(async (req) => {
  const input = await body(req, Start);
  if (input.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "File is larger than 5 GB");
  const ext = path.extname(input.filename).toLowerCase();
  if (!VIDEO_EXT.has(ext)) throw new HttpError(415, `Unsupported file type ${ext || "(none)"}`);

  const title = path.basename(input.filename, ext).replace(/[_-]+/g, " ").trim() || "Untitled";
  const project = input.projectId ? getProject(input.projectId) : createProject(title);
  if (!project) throw new HttpError(404, "Project not found");
  const source = createSource(project.id, { origin: "upload", filename: path.basename(input.filename), sizeBytes: input.size, status: "uploading" });
  run("update source_videos set storage_key = ? where id = ?", `sources/${source.id}/source${ext}`, source.id);
  return ok({ projectId: project.id, sourceId: source.id, chunkSize: CHUNK_BYTES }, { status: 201 });
});
