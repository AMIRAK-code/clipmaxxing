"use client";

import { Link2, Loader2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, Input, Progress } from "@/components/ui/primitives";
import { api, cn, formatBytes } from "@/lib/utils";

const MAX_BYTES = 5 * 1024 ** 3;

/** Upload a file in ordered chunks; retries a failed chunk from the offset the server reports. */
async function uploadFile(file: File, onProgress: (fraction: number) => void): Promise<string> {
  const start = await api<{ projectId: string; sourceId: string; chunkSize: number }>("/api/uploads", {
    method: "POST",
    json: { filename: file.name, size: file.size },
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
  return start.projectId;
}

export function NewProject() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [upload, setUpload] = useState<{ name: string; size: number; progress: number } | null>(null);
  const [url, setUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startUpload = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      if (file.size > MAX_BYTES) return setError("That file is larger than 5 GB.");
      setUpload({ name: file.name, size: file.size, progress: 0 });
      try {
        const projectId = await uploadFile(file, (progress) => setUpload({ name: file.name, size: file.size, progress }));
        router.push(`/projects/${projectId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Upload failed");
        setUpload(null);
      }
    },
    [router],
  );

  const importUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setError(null);
    setImporting(true);
    try {
      const res = await api<{ project: { id: string } }>("/api/projects", { method: "POST", json: { youtubeUrl: url.trim() } });
      router.push(`/projects/${res.project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      setImporting(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload a video file"
          onClick={() => !upload && input.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !upload && input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!upload) void startUpload(e.dataTransfer.files[0]);
          }}
          className={cn(
            "flex min-h-36 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
            drag ? "border-accent bg-accent/10" : "border-line hover:border-accent/60",
          )}
        >
          <input
            ref={input}
            type="file"
            aria-label="Choose a video file to upload"
            tabIndex={-1}
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.mkv,.webm,.m4v,.avi"
            className="hidden"
            onChange={(e) => void startUpload(e.target.files?.[0])}
          />
          {upload ? (
            <div className="w-full max-w-xs">
              <p className="truncate text-sm font-semibold">{upload.name}</p>
              <p className="mb-2 text-xs text-muted">
                {formatBytes(upload.size * upload.progress)} of {formatBytes(upload.size)}
              </p>
              <Progress value={upload.progress} />
            </div>
          ) : (
            <>
              <Upload className="h-6 w-6 text-accent-2" />
              <p className="text-sm font-semibold">Drop a video or click to upload</p>
              <p className="text-xs text-muted">MP4, MOV, MKV or WebM · up to 5 GB</p>
            </>
          )}
        </div>

        <form onSubmit={importUrl} className="flex min-h-36 flex-col justify-center gap-3 rounded-xl border border-line px-4 py-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Link2 className="h-4 w-4 text-accent-2" /> Paste a YouTube link
          </div>
          <div className="flex gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=…"
              aria-label="YouTube URL"
              inputMode="url"
            />
            <Button type="submit" disabled={importing || !url.trim()}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Import"}
            </Button>
          </div>
          <p className="text-xs text-muted">Only import videos you own or have permission to reuse.</p>
        </form>
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
