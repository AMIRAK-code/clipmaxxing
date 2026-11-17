"use client";

import { totalDuration, type Clip, type Job, type MontageScene, type Project, type Render, type SourceVideo } from "@klipz/shared";
import { AlertTriangle, Download, Layers, Loader2, Pencil, Plus, Shuffle, Trash2, WifiOff } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { JobList } from "@/components/job-list";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Progress, Select } from "@/components/ui/primitives";
import { useJobs } from "@/hooks/use-jobs";
import { api, fileUrl, formatDuration } from "@/lib/utils";

interface MontageData {
  project: Project;
  inputs: SourceVideo[];
  pool: SourceVideo | null;
  scenes: MontageScene[];
  montages: Clip[];
  renders: Record<string, Render>;
  jobs: Job[];
}

const LIVE = new Set(["queued", "running"]);

export function MontageView({ initial, initialWorkerAlive }: { initial: MontageData; initialWorkerAlive: boolean }) {
  const projectId = initial.project.id;
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState(3);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setData(await api<MontageData>(`/api/montage/${projectId}`));
    } catch {
      /* the next job event retries */
    }
  }, [projectId]);
  const { jobs, workerAlive } = useJobs(projectId, initial.jobs, () => void refetch());
  const offline = (workerAlive ?? initialWorkerAlive) === false;
  const montageJob = jobs.find((j) => j.type === "montage") ?? null;
  const working = montageJob !== null && LIVE.has(montageJob.status);
  const failed = montageJob !== null && (montageJob.status === "failed" || montageJob.status === "dead");
  const settings = data.project.settings;

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const renderJob = (renderId: string | undefined) =>
    renderId ? jobs.find((j) => j.type === "render" && (j.payload as { render_id?: string }).render_id === renderId && LIVE.has(j.status)) : undefined;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/montage" className="text-xs text-muted hover:text-fg">
            ← Montage
          </Link>
          <h1 className="text-2xl font-black tracking-tight">{data.project.title}</h1>
          <p className="text-sm text-muted">
            {data.inputs.length} video{data.inputs.length === 1 ? "" : "s"}
            {data.scenes.length ? ` · ${data.scenes.length} scenes found` : ""}
            {settings ? ` · ${settings.minSec}–${settings.maxSec} s each` : ""}
          </p>
        </div>
        {data.scenes.length > 0 ? (
          <div className="flex items-center gap-2">
            <Select value={more} onChange={(e) => setMore(Number(e.target.value))} aria-label="How many more montages" className="h-9 w-20">
              {[1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
            <Button
              onClick={() => void act("more", () => api(`/api/montage/${projectId}`, { method: "POST", json: { action: "more", count: more } }))}
              disabled={busy !== null}
            >
              {busy === "more" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Make more
            </Button>
          </div>
        ) : null}
      </header>

      {offline ? (
        <Card className="flex items-center gap-2 border-warn/40 p-3 text-sm text-warn">
          <WifiOff className="h-4 w-4" /> The video worker is not running, so nothing is being processed right now.
        </Card>
      ) : null}

      {working && montageJob ? (
        <Card className="flex flex-col gap-2 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-semibold">
              <Loader2 className="h-4 w-4 animate-spin text-accent-2" /> {montageJob.stage ?? (montageJob.status === "queued" ? "Waiting to start" : "Working")}
            </span>
            <span className="tabular-nums text-muted">{Math.round(montageJob.progress * 100)}%</span>
          </div>
          <Progress value={montageJob.progress} />
          <p className="text-xs text-muted">Every video is transcribed and scanned for its most exciting moments. This takes a few minutes for longer videos.</p>
        </Card>
      ) : null}

      {failed && montageJob ? (
        <Card className="flex flex-col gap-2 border-bad/40 p-4 text-sm">
          <span className="flex items-center gap-2 font-semibold text-bad">
            <AlertTriangle className="h-4 w-4" /> The montages could not be made
          </span>
          <span className="text-muted">{montageJob.error}</span>
          <JobList jobs={[montageJob]} showDone />
        </Card>
      ) : null}

      {data.montages.length === 0 && !working && !failed ? (
        <EmptyState title="No montages yet" icon={<Layers className="h-8 w-8" />}>
          {data.inputs.some((s) => s.status === "uploading") ? "Waiting for the uploads to finish." : "The montages appear here once the videos are processed."}
        </EmptyState>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data.montages.map((m) => {
          const r = data.renders[m.id];
          const ready = r?.status === "ready" && r.storage_key;
          const rj = renderJob(r?.id);
          const len = m.edit_state ? totalDuration(m.edit_state.video) : 0;
          return (
            <Card key={m.id} className="flex flex-col overflow-hidden" data-montage={m.id}>
              <div className="relative aspect-[9/16] w-full bg-panel-2">
                {ready ? (
                  <video
                    key={r.storage_key}
                    src={fileUrl(r.storage_key) ?? undefined}
                    poster={fileUrl(r.cover_key) ?? undefined}
                    controls
                    preload="metadata"
                    playsInline
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted">
                    {r?.status === "failed" ? (
                      <>
                        <AlertTriangle className="h-6 w-6 text-bad" /> Rendering failed{r.error ? `: ${r.error}` : ""}
                      </>
                    ) : (
                      <>
                        <Loader2 className="h-6 w-6 animate-spin text-accent-2" />
                        {rj?.status === "running" ? `Rendering ${Math.round(rj.progress * 100)}%` : "Waiting to render"}
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-semibold">{m.title}</p>
                  <Badge>{formatDuration(len)}</Badge>
                </div>
                <p className="text-xs text-muted">{m.edit_state?.video.length ?? 0} scenes</p>
                <div className="flex flex-wrap gap-1.5">
                  <Link href={`/clips/${m.id}`}>
                    <Button size="sm" variant="secondary">
                      <Pencil className="h-3.5 w-3.5" /> Edit
                    </Button>
                  </Link>
                  {ready ? (
                    <a href={fileUrl(r.storage_key) ?? undefined} download={`${m.title ?? "montage"}.mp4`}>
                      <Button size="sm" variant="secondary" aria-label={`Download ${m.title}`}>
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </a>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    title="New mix: other scenes, same settings"
                    aria-label={`New mix for ${m.title}`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (m.edit_version > 0 && !window.confirm("A new mix replaces the scenes you edited. Continue?")) return;
                      void act(`remix:${m.id}`, () => api(`/api/montage/${projectId}`, { method: "POST", json: { action: "remix", clipId: m.id } }));
                    }}
                  >
                    {busy === `remix:${m.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shuffle className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${m.title}`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm(`Delete ${m.title}?`)) return;
                      void act(`del:${m.id}`, () => api(`/api/clips/${m.id}`, { method: "DELETE" }));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
