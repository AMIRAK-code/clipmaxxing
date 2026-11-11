export interface UploadedAsset {
  key: string;
  kind: "video" | "image" | "audio";
  size: number;
  name?: string;
}

/** Stream a file to POST /api/assets as a raw body (no in-memory multipart parsing). */
export async function uploadAsset(file: File): Promise<UploadedAsset> {
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name) },
    body: file,
  });
  const data = (await res.json().catch(() => null)) as (UploadedAsset & { error?: string }) | null;
  if (!res.ok || !data) throw new Error(data?.error ?? `Upload failed (${res.status})`);
  return data;
}

/** Duration of a local video/audio file via a temporary media element. Images have none. */
export function readMediaDuration(file: File, timeoutMs = 8000): Promise<number | null> {
  if (file.type.startsWith("image/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
    const url = URL.createObjectURL(file);
    const done = (v: number | null) => {
      clearTimeout(timer);
      el.removeAttribute("src");
      el.load();
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    el.preload = "metadata";
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => done(null);
    el.src = url;
  });
}
