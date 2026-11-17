"use client";

import { Loader2, Shuffle, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { uploadFile } from "@/components/new-project";
import { MontageSettingsFields } from "@/components/project/montage-settings";
import { Button } from "@/components/ui/button";
import { Card, Input, Progress } from "@/components/ui/primitives";
import { MONTAGE_DEFAULTS, type MontageSettings } from "@/lib/montage";
import { api, cn, formatBytes } from "@/lib/utils";

const MAX_BYTES = 5 * 1024 ** 3;
const ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.mkv,.webm,.m4v,.avi";

/** Pick several videos, choose how many montages and how long, upload them all and start the job. */
export function NewMontage() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState("");
  const [settings, setSettings] = useState<MontageSettings>(MONTAGE_DEFAULTS);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<{ index: number; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = (list: FileList | null) => {
    if (!list) return;
    setError(null);
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > MAX_BYTES) {
        setError(`${f.name} is larger than 5 GB.`);
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    setFiles(next);
  };

  async function start() {
    if (!files.length) return;
    setError(null);
    setProgress({ index: 0, fraction: 0 });
    try {
      const { project } = await api<{ project: { id: string } }>("/api/montages", {
        method: "POST",
        json: { ...settings, title: title.trim() || undefined },
      });
      for (const [index, f] of files.entries()) {
        await uploadFile(f, (fraction) => setProgress({ index, fraction }), project.id);
      }
      // the project page asks: built-in engine (starts the montage job) or Manual AI Mode
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the montage");
      setProgress(null);
    }
  }

  const busy = progress !== null;
  const total = files.reduce((n, f) => n + f.size, 0);
  const done = progress
    ? files.slice(0, progress.index).reduce((n, f) => n + f.size, 0) + (files[progress.index]?.size ?? 0) * progress.fraction
    : 0;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div
        role="button"
        tabIndex={0}
        aria-label="Add videos for a montage"
        onClick={() => !busy && input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (!busy) add(e.dataTransfer.files);
        }}
        className={cn(
          "flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-5 text-center transition-colors",
          drag ? "border-accent bg-accent/10" : "border-line hover:border-accent/60",
        )}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          aria-label="Choose videos"
          tabIndex={-1}
          onChange={(e) => add(e.target.files)}
        />
        <Upload className="h-6 w-6 text-accent-2" />
        <p className="text-sm font-semibold">Drop videos or click to choose several</p>
        <p className="text-xs text-muted">MP4, MOV, MKV or WebM · up to 5 GB each</p>
      </div>

      {files.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="montage-files">
          {files.map((f, i) => (
            <li key={`${f.name}:${f.size}`} className="flex items-center gap-3 rounded-lg border border-line px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-muted">{formatBytes(f.size)}</span>
              <Button
                size="iconSm"
                variant="ghost"
                aria-label={`Remove ${f.name}`}
                disabled={busy}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Name (optional)
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Montage" aria-label="Montage name" />
        </label>
        <MontageSettingsFields value={settings} onChange={setSettings} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void start()} disabled={busy || files.length === 0} data-testid="start-montage">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
          Make montages
        </Button>
        {busy ? (
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <p className="text-xs text-muted">
              Uploading {progress.index + 1} of {files.length} · {formatBytes(done)} of {formatBytes(total)}
            </p>
            <Progress value={total ? done / total : 0} />
          </div>
        ) : (
          <p className="text-xs text-muted">
            Only use videos you own or have permission to reuse. Montages have no captions; you can turn them on in the editor.
          </p>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
