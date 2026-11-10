import fs from "node:fs";
import { run } from "@/server/db";
import { HttpError, notFound, ok, route } from "@/server/http";
import { enqueueJob } from "@/server/jobs";
import { ensureParent, storagePath } from "@/server/paths";
import { getSource } from "@/server/repo";

export const dynamic = "force-dynamic";

const partPath = (key: string) => `${storagePath(key)}.part`;

/** How many bytes are already on disk – lets the browser resume an interrupted upload. */
export const GET = route<{ id: string }>((_req, { id }) => {
  const source = getSource(id) ?? notFound();
  if (!source.storage_key) notFound();
  let received = 0;
  try {
    received = fs.statSync(partPath(source.storage_key!)).size;
  } catch {
    received = 0;
  }
  return ok({ received, size: source.size_bytes, status: source.status });
});

/** Append one chunk at ?offset=N. Chunks must arrive in order; a repeat of the last chunk is harmless. */
export const PUT = route<{ id: string }>(async (req, { id }) => {
  const source = getSource(id) ?? notFound();
  if (source.status !== "uploading" || !source.storage_key) throw new HttpError(409, "Upload is not in progress");
  const offset = Number(new URL(req.url).searchParams.get("offset"));
  if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, "Bad offset");

  const file = ensureParent(partPath(source.storage_key));
  const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (offset > have) throw new HttpError(409, `Expected offset ${have}`);
  const chunk = Buffer.from(await req.arrayBuffer());
  if (offset + chunk.length > (source.size_bytes ?? 0)) throw new HttpError(413, "Chunk exceeds declared file size");

  const fd = fs.openSync(file, have === 0 ? "w" : "r+");
  try {
    fs.writeSync(fd, chunk, 0, chunk.length, offset);
    if (offset + chunk.length < have) fs.ftruncateSync(fd, offset + chunk.length);
  } finally {
    fs.closeSync(fd);
  }
  return ok({ received: offset + chunk.length });
});

/** Finish: verify the size, move the file into place and queue ingest. */
export const POST = route<{ id: string }>((_req, { id }) => {
  const source = getSource(id) ?? notFound();
  if (!source.storage_key) notFound();
  const finalPath = storagePath(source.storage_key!);
  if (source.status === "uploading") {
    const part = partPath(source.storage_key!);
    const size = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size !== source.size_bytes) throw new HttpError(409, `Upload incomplete (${size} of ${source.size_bytes} bytes)`);
    fs.renameSync(part, finalPath);
    run("update source_videos set status = 'pending' where id = ?", id);
  }
  const job = enqueueJob("ingest", { source_video_id: id }, { projectId: source.project_id, dedupeKey: `ingest:${id}` });
  return ok({ job });
});
