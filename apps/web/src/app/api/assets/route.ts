import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpError, ok, route } from "@/server/http";
import { MAX_ASSET_BYTES, validateAssetUpload } from "@/server/assets";
import { ensureParent, storagePath } from "@/server/paths";

export const dynamic = "force-dynamic";

/**
 * Upload a b-roll / audio asset. Two body shapes:
 *  - raw: the file bytes with `x-filename` (URL-encoded) and its content-type (streamed to disk)
 *  - multipart/form-data with a `file` field
 * Stored as assets/<uuid>.<ext>. Returns { key, kind, size }; duration is read by the browser.
 */
export const POST = route(async (req) => {
  const ctype = req.headers.get("content-type") ?? "";
  const declared = Number(req.headers.get("content-length") ?? "") || null;

  if (ctype.startsWith("multipart/form-data")) {
    if (declared && declared > MAX_ASSET_BYTES + 1024 * 1024) throw new HttpError(413, "File is larger than 500 MB");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, 'Missing "file" field');
    const check = validateAssetUpload({ name: file.name, type: file.type, size: file.size });
    const dest = ensureParent(storagePath(check.key));
    await pipeline(Readable.fromWeb(file.stream() as never), fs.createWriteStream(dest));
    return ok({ key: check.key, kind: check.kind, size: file.size, name: file.name });
  }

  const rawName = req.headers.get("x-filename") ?? "";
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    /* keep raw */
  }
  const check = validateAssetUpload({ name, type: ctype, size: declared });
  if (!req.body) throw new HttpError(400, "Empty body");
  const dest = ensureParent(storagePath(check.key));
  const tmp = `${dest}.part`;
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_ASSET_BYTES) cb(new HttpError(413, "File is larger than 500 MB"));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(req.body as never), limiter, fs.createWriteStream(tmp));
    if (bytes === 0) throw new HttpError(400, "File is empty");
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return ok({ key: check.key, kind: check.kind, size: bytes, name: path.basename(name) });
});
