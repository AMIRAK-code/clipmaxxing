import { randomUUID } from "node:crypto";
import path from "node:path";
import { HttpError } from "./http";

export const MAX_ASSET_BYTES = 500 * 1024 * 1024;
/** multipart bodies are parsed in memory by the platform, so they are capped small; big files use the raw streaming path */
export const MAX_MULTIPART_BYTES = 8 * 1024 * 1024;

export type AssetKind = "video" | "image" | "audio";

/** Allowed extensions → kind. The stored extension always comes from this table, never from the client. */
export const ASSET_EXT: Record<string, AssetKind> = {
  ".mp4": "video",
  ".m4v": "video",
  ".mov": "video",
  ".webm": "video",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".ogg": "audio",
};

const MIME_KIND = /^(video|image|audio)\//;

export interface AssetCheck {
  kind: AssetKind;
  ext: string;
  key: string;
}

/**
 * Validate an upload by declared name, MIME type and size. Throws HttpError
 * (400 / 413 / 415). Returns the storage key `assets/<uuid>.<ext>`.
 */
export function validateAssetUpload(input: { name: string; type: string; size: number | null }, id: string = randomUUID()): AssetCheck {
  const base = path.basename((input.name || "").replace(/\\/g, "/"));
  const ext = path.extname(base).toLowerCase();
  const kind = ASSET_EXT[ext];
  if (!kind) throw new HttpError(415, `Unsupported file type "${ext || base || "unknown"}". Use a video, image or audio file.`);
  const mime = (input.type || "").toLowerCase().split(";")[0]!.trim();
  if (mime && mime !== "application/octet-stream") {
    const m = MIME_KIND.exec(mime);
    if (!m) throw new HttpError(415, `Unsupported content type ${mime}. Only video, image and audio files are accepted.`);
    // an .mp3 that claims to be a video (or vice versa) is rejected; mp4 audio-only (.m4a) may be labelled video/mp4
    if (m[1] !== kind && !(kind === "audio" && mime === "video/mp4")) {
      throw new HttpError(415, `File extension ${ext} does not match content type ${mime}.`);
    }
  }
  if (input.size != null) {
    if (!Number.isFinite(input.size) || input.size <= 0) throw new HttpError(400, "File is empty");
    if (input.size > MAX_ASSET_BYTES) throw new HttpError(413, "File is larger than 500 MB");
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "Bad asset id");
  return { kind, ext, key: `assets/${id}${ext}` };
}
