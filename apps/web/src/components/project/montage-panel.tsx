"use client";

import type { Job, MontageOptions, Project, SourceVideo } from "@klipz/shared";
import { AlertTriangle, Plus, Shuffle } from "lucide-react";
import { useRef, useState } from "react";
import { uploadFile } from "@/components/new-project";
import { Button } from "@/components/ui/button";
import { Card, Progress } from "@/components/ui/primitives";
import { MONTAGE_DEFAULTS } from "@/lib/montage";
import { api, formatDuration } from "@/lib/utils";
import { MontageSettingsFields } from "./montage-settings";

const ACTIVE = new Set(["queued", "running"]);

/** A montage project's videos and the "make montages" controls (instead of Find clips / AutoClip). */
export function MontagePanel({ project, inputs, jobs, onChange }: { project: Project; inputs: SourceVideo[]; jobs: Job[]; onChange: () => void }) {
  const opts: MontageOptions = project.options ?? MONTAGE_DEFAULTS;
  const [settings, setSettings] = useState({ count: opts.count, minSec: opts.minSec, maxSec: opts.maxSec });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const job = jobs.find((j) => j.type === "montage" && ACTIVE.has(j.status));
  const lastJob = jobs.find((j) => j.type === "montage");
  const failed = lastJob && (lastJob.status === "failed" || lastJob.status === "dead") ? lastJob : null;
  const importing = inputs.some((s) => s.status === "uploading") || upload !== null;
  const usable = inputs.filter((s) => s.status !== "failed" && s.status !== "deleted");
  const changed = (project.options?.poolInputs ?? []).length > 0 && [...usable.map((s) => s.id)].sort().join() !== [...(project.options?.poolInputs ?? [])].sort().join();

  async function make() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/montages/${project.id}`, { method: "POST", json: settings });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    } finally {
      setBusy(false);
    }
  }

  async function addVideos(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    try {
      for (const f of Array.from(files)) {
        setUpload({ name: f.name, progress: 0 });
        await uploadFile(f, (p) => setUpload({ name: f.name, progress: p }), project.id);
      }
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUpload(null);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="montage-panel">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">Videos ({inputs.length})</h2>
          <Button size="sm" variant="secondary" onClick={() => picker.current?.click()} disabled={importing}>
            <Plus className="h-3.5 w-3.5" /> Add videos
          </Button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.mkv,.webm,.m4v,.avi"
            onChange={(e) => void addVideos(e.target.files)}
          />
        </div>
        <ul className="flex flex-col gap-1.5">
          {inputs.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm">
              <span className="min-w-0 truncate">{s.filename ?? "Video"}</span>
              <span className="shrink-0 text-xs text-muted">
                {s.status === "ready" ? formatDuration(s.duration_sec ?? 0) : s.status === "failed" ? "failed" : s.status === "uploading" ? "uploading" : "importing"}
              </span>
            </li>
          ))}
        </ul>
        {upload ? (
          <div className="flex flex-col gap-1">
            <p className="truncate text-xs text-muted">Uploading {upload.name}</p>
            <Progress value={upload.progress} />
          </div>
        ) : null}
        {changed ? <p className="text-xs text-muted">The videos changed: the next montages are cut from all of them again.</p> : null}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <MontageSettingsFields value={settings} onChange={setSettings} />
        <Button onClick={() => void make()} disabled={busy || importing || !!job || usable.length === 0} data-testid="make-montages">
          <Shuffle className="h-4 w-4" aria-hidden /> {lastJob ? "Make more montages" : "Make montages"}
        </Button>
        {job ? (
          <div className="flex flex-col gap-1.5" role="status">
            <Progress value={job.progress ?? 0} />
            <p className="text-xs text-muted">{job.status === "queued" ? "Waiting for the worker" : (job.stage ?? "Starting")}</p>
          </div>
        ) : failed ? (
          <p role="alert" className="flex items-start gap-2 text-xs text-bad">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {failed.error ?? "The montage job failed."}
          </p>
        ) : null}
        <p className="text-xs text-muted">
          KLIPZ picks the moments where something happens in each video (lively speech, loud or fast parts), then mixes scenes of
          different videos in a random order. Montages have no captions; switch them on, mute the sound, add a hook card or add and
          remove scenes in the editor.
        </p>
        {error ? (
          <p role="alert" className="text-xs text-bad">
            {error}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
