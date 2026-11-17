"use client";

import { MONTAGE_DEFAULTS, MONTAGE_LIMITS } from "@klipz/shared";
import { Film, Loader2, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, Input, Progress } from "@/components/ui/primitives";
import { MAX_UPLOAD_BYTES, VIDEO_ACCEPT, uploadFile } from "@/lib/upload";
import { api, cn, formatBytes } from "@/lib/utils";

const [MIN_INPUTS, MAX_INPUTS] = MONTAGE_LIMITS.inputs;

/** Several videos in, N short montages out: choose files, how many montages, and how long each is. */
export function NewMontage() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [title, setTitle] = useState("");
  const [count, setCount] = useState(MONTAGE_DEFAULTS.count);
  const [minSec, setMinSec] = useState(MONTAGE_DEFAULTS.minSec);
  const [maxSec, setMaxSec] = useState(MONTAGE_DEFAULTS.maxSec);
  const [progress, setProgress] = useState<{ index: number; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null;

  function add(list: FileList | null | undefined) {
    if (!list) return;
    setError(null);
    const next = [...files];
    for (const f of Array.from(list)) {
      if (f.size > MAX_UPLOAD_BYTES) {
        setError(`${f.name} is larger than 5 GB.`);
        continue;
      }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    if (next.length > MAX_INPUTS) setError(`A montage takes at most ${MAX_INPUTS} videos.`);
    setFiles(next.slice(0, MAX_INPUTS));
  }

  const lo = Math.min(minSec, maxSec);
  const hi = Math.max(minSec, maxSec);
  const total = files.reduce((a, f) => a + f.size, 0);
  const done = progress ? files.slice(0, progress.index).reduce((a, f) => a + f.size, 0) + (files[progress.index]?.size ?? 0) * progress.fraction : 0;

  async function create() {
    if (files.length < MIN_INPUTS) return setError(`Add at least ${MIN_INPUTS} videos.`);
    setError(null);
    setProgress({ index: 0, fraction: 0 });
    try {
      const { project } = await api<{ project: { id: string } }>("/api/montage", {
        method: "POST",
        json: { title: title.trim() || undefined, settings: { count, minSec: lo, maxSec: hi } },
      });
      for (let i = 0; i < files.length; i++) {
        setProgress({ index: i, fraction: 0 });
        await uploadFile(files[i]!, (fraction) => setProgress({ index: i, fraction }), project.id);
      }
      await api(`/api/montage/${project.id}`, { method: "POST", json: { action: "start" } });
      router.push(`/montage/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setProgress(null);
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div
        role="button"
        tabIndex={0}
        aria-label="Add videos to the montage"
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
          aria-label="Choose videos for the montage"
          tabIndex={-1}
          accept={VIDEO_ACCEPT}
          className="hidden"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = "";
          }}
        />
        <Upload className="h-6 w-6 text-accent-2" />
        <p className="text-sm font-semibold">Drop {MIN_INPUTS}–{MAX_INPUTS} videos or click to choose</p>
        <p className="text-xs text-muted">KLIPZ picks the exciting moments of each and mixes them into short vertical videos.</p>
      </div>

      {files.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Videos in this montage">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}`} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
              <Film className="h-4 w-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="shrink-0 text-xs text-muted">{formatBytes(f.size)}</span>
              {progress && progress.index === i ? <span className="w-10 text-right text-xs tabular-nums">{Math.round(progress.fraction * 100)}%</span> : null}
              {progress && progress.index > i ? <span className="w-10 text-right text-xs text-good">done</span> : null}
              {!busy ? (
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-muted hover:text-fg">
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <label className="flex flex-col gap-1 text-xs text-muted sm:col-span-1">
          Name
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Montage" maxLength={160} disabled={busy} aria-label="Montage name" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          How many videos to make
          <Input
            type="number"
            min={MONTAGE_LIMITS.count[0]}
            max={MONTAGE_LIMITS.count[1]}
            value={count}
            disabled={busy}
            aria-label="Number of montages"
            onChange={(e) => setCount(Math.min(MONTAGE_LIMITS.count[1], Math.max(MONTAGE_LIMITS.count[0], Number(e.target.value) || 1)))}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Shortest (seconds)
          <Input type="number" min={MONTAGE_LIMITS.sec[0]} max={MONTAGE_LIMITS.sec[1]} value={minSec} disabled={busy} aria-label="Shortest montage in seconds"
            onChange={(e) => setMinSec(Math.min(MONTAGE_LIMITS.sec[1], Math.max(MONTAGE_LIMITS.sec[0], Number(e.target.value) || MONTAGE_LIMITS.sec[0])))} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Longest (seconds)
          <Input type="number" min={MONTAGE_LIMITS.sec[0]} max={MONTAGE_LIMITS.sec[1]} value={maxSec} disabled={busy} aria-label="Longest montage in seconds"
            onChange={(e) => setMaxSec(Math.min(MONTAGE_LIMITS.sec[1], Math.max(MONTAGE_LIMITS.sec[0], Number(e.target.value) || MONTAGE_LIMITS.sec[1])))} />
        </label>
      </div>

      {busy ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted">
            Uploading video {progress.index + 1} of {files.length} · {formatBytes(done)} of {formatBytes(total)}
          </p>
          <Progress value={total ? done / total : 0} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {count} montage{count === 1 ? "" : "s"} of {lo}–{hi} s, no captions (you can add them in the editor). Only use videos you own or may reuse.
        </p>
        <Button onClick={() => void create()} disabled={busy || files.length < MIN_INPUTS}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? "Uploading…" : `Make ${count} montage${count === 1 ? "" : "s"}`}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
