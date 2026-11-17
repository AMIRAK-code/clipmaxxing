import { api } from "@/lib/utils";

export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
export const VIDEO_ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.mkv,.webm,.m4v,.avi";

/**
 * Upload a file in ordered chunks; retries a failed chunk from the offset the server reports.
 * Without `projectId` the server makes a new project for it; with one the file is added to that project.
 */
export async function uploadFile(file: File, onProgress: (fraction: number) => void, projectId?: string): Promise<{ projectId: string; sourceId: string }> {
  const start = await api<{ projectId: string; sourceId: string; chunkSize: number }>("/api/uploads", {
    method: "POST",
    json: { filename: file.name, size: file.size, ...(projectId ? { projectId } : {}) },
  });
  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, offset + start.chunkSize);
    try {
      const res = await api<{ received: number }>(`/api/uploads/${start.sourceId}?offset=${offset}`, { method: "PUT", body: chunk });
      offset = res.received;
      failures = 0;
      onProgress(offset / file.size);
    } catch (e) {
      if (++failures > 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** failures));
      const state = await api<{ received: number }>(`/api/uploads/${start.sourceId}`);
      offset = state.received;
    }
  }
  await api(`/api/uploads/${start.sourceId}`, { method: "POST" });
  return { projectId: start.projectId, sourceId: start.sourceId };
}
