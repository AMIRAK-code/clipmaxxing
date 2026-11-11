"use client";

import type { Clip, Job, Project, SourceVideo, Word } from "@klipz/shared";
import { AlertTriangle, Scissors, Sparkles, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { JobList } from "@/components/job-list";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Progress } from "@/components/ui/primitives";
import { useJobs } from "@/hooks/use-jobs";
import { actionBlockReason, filterClips, latestJob, rankClips, type ClipFilter } from "@/lib/clip-ui";
import { api, cn } from "@/lib/utils";
import { ClipCard } from "./clip-card";
import { ClipPreview } from "./clip-preview";
import { ProjectHeader } from "./project-header";
import { SourceCard } from "./source-card";
import { TrimControl } from "./trim-control";

interface ProjectData {
  project: Project;
  source: SourceVideo | null;
  clips: Clip[];
  jobs: Job[];
}

const FILTERS: { id: ClipFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "kept", label: "Kept" },
  { id: "candidate", label: "Candidates" },
];

export function ProjectView({ initial, initialWorkerAlive }: { initial: ProjectData; initialWorkerAlive: boolean }) {
  const projectId = initial.project.id;
  const [title, setTitle] = useState(initial.project.title);
  const [source, setSource] = useState(initial.source);
  const [clips, setClips] = useState(initial.clips);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClipFilter>("all");
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [words, setWords] = useState<Word[]>([]);

  const refetch = useCallback(async () => {
    try {
      const d = await api<ProjectData>(`/api/projects/${projectId}`);
      setSource(d.source);
      setClips(d.clips);
    } catch {
      /* the next job event retries */
    }
  }, [projectId]);

  const { jobs, workerAlive } = useJobs(projectId, initial.jobs, () => void refetch());
  const offline = (workerAlive ?? initialWorkerAlive) === false;

  const ranked = useMemo(() => rankClips(clips), [clips]);
  const rankOf = useMemo(() => new Map(ranked.map((c, i) => [c.id, i + 1])), [ranked]);
  const { visible, discarded } = filterClips(ranked, filter);
  const selected = clips.find((c) => c.id === selectedId) ?? null;

  // Default selection: best visible clip.
  useEffect(() => {
    if (selectedId && clips.some((c) => c.id === selectedId)) return;
    setSelectedId(visible[0]?.id ?? ranked[0]?.id ?? null);
  }, [clips, selectedId, visible, ranked]);

  // Transcript around the selected clip (wide enough for the trim control).
  const selStart = selected?.start_sec ?? 0;
  const selEnd = selected?.end_sec ?? 0;
  const winKey = selected ? `${selected.id}:${Math.floor(selStart / 10)}:${Math.floor(selEnd / 10)}` : "";
  useEffect(() => {
    if (!selected || !source) return;
    let live = true;
    api<{ words: Word[] }>(`/api/sources/${source.id}/transcript?from=${Math.max(0, selStart - 30)}&to=${selEnd + 30}`)
      .then((t) => live && setWords(t.words))
      .catch(() => live && setWords([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winKey, source?.id]);

  async function patchClip(id: string, patch: Record<string, unknown>) {
    const prev = clips.find((c) => c.id === id);
    if (!prev) return;
    const optimistic: Clip = { ...prev, ...(patch as Partial<Clip>) };
    if ("start_sec" in patch || "end_sec" in patch) optimistic.crop_track = null;
    setClips((cs) => cs.map((c) => (c.id === id ? optimistic : c)));
    try {
      const r = await api<{ clip: Clip }>(`/api/clips/${id}`, { method: "PATCH", json: patch });
      setClips((cs) => cs.map((c) => (c.id === id ? r.clip : c)));
      setError(null);
    } catch (e) {
      setClips((cs) => cs.map((c) => (c.id === id ? prev : c)));
      setError(e instanceof Error ? e.message : "Could not save the change");
    }
  }

  async function start(type: "analyze" | "autoclip") {
    if (!source) return;
    setStarting(type);
    setError(null);
    try {
      await api("/api/jobs", { method: "POST", json: { type, sourceVideoId: source.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the job");
    } finally {
      setStarting(null);
    }
  }

  const findBlock = actionBlockReason(source, jobs, "analyze");
  const autoBlock = actionBlockReason(source, jobs, "autoclip");
  const analyzing = jobs.some((j) => (j.type === "analyze" || j.type === "autoclip") && (j.status === "queued" || j.status === "running"));
  const analyzeJob = jobs.find((j) => (j.type === "analyze" || j.type === "autoclip") && (j.status === "queued" || j.status === "running"));
  const lastAnalysis = latestJob(jobs, ["analyze", "autoclip"]);
  const failedAnalysis = lastAnalysis && (lastAnalysis.status === "failed" || lastAnalysis.status === "dead") ? lastAnalysis : undefined;

  async function retryFailed(id: string) {
    try {
      await api(`/api/jobs/${id}`, { method: "POST", json: { action: "retry" } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
    }
  }

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5 p-6">
      <ProjectHeader projectId={projectId} title={title} onTitle={setTitle} />

      {offline ? (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <p>
            The background worker isn&apos;t running, so nothing will be processed. Open a terminal in the project folder and run{" "}
            <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs">npm run worker</code>.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SourceCard source={source} />
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex flex-col gap-1">
              <Button onClick={() => void start("analyze")} disabled={findBlock !== null || starting !== null} title={findBlock ?? "Find the strongest moments in this video"}>
                <Scissors className="h-4 w-4" aria-hidden /> Find clips
              </Button>
              {findBlock ? <p className="max-w-[220px] text-xs text-muted">{findBlock}</p> : null}
            </div>
            <div className="flex flex-col gap-1">
              <Button
                variant="secondary"
                onClick={() => void start("autoclip")}
                disabled={autoBlock !== null || starting !== null}
                title={autoBlock ?? "Finds moments, reframes, captions and renders the top clips"}
              >
                <Sparkles className="h-4 w-4" aria-hidden /> AutoClip
              </Button>
              {autoBlock ? <p className="max-w-[220px] text-xs text-muted">{autoBlock}</p> : null}
            </div>
          </div>
          <p className="text-xs text-muted">
            <strong className="font-semibold text-fg">AutoClip</strong> finds the moments, reframes them to 9:16, adds captions and renders the top clips in one go.
          </p>
          {error ? (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          ) : null}
        </Card>
      </div>

      <JobList jobs={jobs} />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px] lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-label="Clips" className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold">Clips</h2>
            <span className="text-sm text-muted">{clips.length - discarded.length}</span>
            <div role="group" aria-label="Filter clips" className="ml-auto flex gap-1 rounded-lg border border-line p-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn("h-7 cursor-pointer rounded-md px-3 text-xs font-semibold", filter === f.id ? "bg-accent text-white" : "text-muted hover:text-fg")}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {clips.length === 0 ? (
            source?.status === "deleted" ? (
              <EmptyState title="The source video was removed">Its file was cleaned up, so new clips can&apos;t be found. Import the video again to analyse it.</EmptyState>
            ) : analyzing ? (
              <EmptyState title="Finding clips…">
                <div className="mt-2 flex w-64 flex-col gap-1.5">
                  <Progress value={analyzeJob?.progress ?? 0} />
                  <p className="h-4 text-xs">{analyzeJob?.status === "queued" ? "Waiting for the worker" : (analyzeJob?.stage ?? "Starting")}</p>
                </div>
              </EmptyState>
            ) : failedAnalysis ? (
              <EmptyState title="Analysis failed" icon={<AlertTriangle className="h-8 w-8 text-bad" />}>
                <p className="break-words text-bad/90">{failedAnalysis.error ?? "The worker reported an error."}</p>
                <Button className="mt-3" variant="secondary" onClick={() => void retryFailed(failedAnalysis.id)}>
                  Retry
                </Button>
              </EmptyState>
            ) : (
              <EmptyState title="No clips yet" icon={<Scissors className="h-8 w-8" />}>
                {findBlock ? findBlock : "Press “Find clips” to let KLIPZ pick the best moments, or “AutoClip” to do everything in one go."}
              </EmptyState>
            )
          ) : (
            <>
              {visible.length === 0 ? <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-muted">No clips match this filter.</p> : null}
              {visible.map((c) => (
                <ClipCard key={c.id} clip={c} rank={rankOf.get(c.id) ?? 0} selected={c.id === selectedId} onSelect={() => setSelectedId(c.id)} onStatus={(s) => void patchClip(c.id, { status: s })} />
              ))}
              {discarded.length > 0 ? (
                <div className="mt-2">
                  <button
                    type="button"
                    aria-expanded={showDiscarded}
                    onClick={() => setShowDiscarded((v) => !v)}
                    className="cursor-pointer rounded text-sm font-semibold text-muted hover:text-fg"
                  >
                    Discarded ({discarded.length}) {showDiscarded ? "▾" : "▸"}
                  </button>
                  {showDiscarded ? (
                    <div className="mt-2 flex flex-col gap-3">
                      {discarded.map((c) => (
                        <ClipCard key={c.id} clip={c} rank={rankOf.get(c.id) ?? 0} selected={c.id === selectedId} onSelect={() => setSelectedId(c.id)} onStatus={(s) => void patchClip(c.id, { status: s })} />
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </section>

        <aside aria-label="Clip preview" className="sticky top-4 flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-panel p-4">
          {selected ? (
            <>
              <h2 className="truncate text-sm font-bold">{selected.title || "Untitled clip"}</h2>
              <ClipPreview clip={selected} source={source} words={words} />
              {source?.status === "ready" ? (
                <TrimControl
                  key={selected.id}
                  start={selected.start_sec}
                  end={selected.end_sec}
                  duration={source.duration_sec}
                  words={words}
                  onCommit={(s, e) => void patchClip(selected.id, { start_sec: s, end_sec: e })}
                />
              ) : null}
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted">Select a clip to preview it here.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
