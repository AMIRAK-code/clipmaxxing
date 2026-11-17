"use client";

import type { Clip, Framing, Job, Project, Render, SourceVideo, Word } from "@klipz/shared";
import { AlertTriangle, Scissors, Sparkles, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { JobList } from "@/components/job-list";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Progress } from "@/components/ui/primitives";
import { useJobs } from "@/hooks/use-jobs";
import { actionBlockReason, filterClips, latestJob, rankClips, type ClipFilter } from "@/lib/clip-ui";
import { api, cn, fileUrl } from "@/lib/utils";
import { ClipCard } from "./clip-card";
import { ClipPreview } from "./clip-preview";
import { MontagePanel } from "./montage-panel";
import { ProjectHeader } from "./project-header";
import { importJob, SourceCard } from "./source-card";
import { TrimControl } from "./trim-control";

interface ProjectData {
  project: Project;
  source: SourceVideo | null;
  /** montage projects: the videos the montages are made from */
  inputs?: SourceVideo[];
  clips: Clip[];
  jobs: Job[];
  /** newest render per clip id */
  renders?: Record<string, Render>;
}

const FILTERS: { id: ClipFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "kept", label: "Kept" },
  { id: "candidate", label: "Candidates" },
];

export function ProjectView({ initial, initialWorkerAlive }: { initial: ProjectData; initialWorkerAlive: boolean }) {
  const projectId = initial.project.id;
  const montage = initial.project.kind === "montage";
  const [project, setProject] = useState(initial.project);
  const [inputs, setInputs] = useState(initial.inputs ?? []);
  const [title, setTitle] = useState(initial.project.title);
  const [source, setSource] = useState(initial.source);
  const [clips, setClips] = useState(initial.clips);
  const [renders, setRenders] = useState<Record<string, Render>>(initial.renders ?? {});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ClipFilter>("all");
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [words, setWords] = useState<Word[]>([]);
  const [renderCount, setRenderCount] = useState(10);
  const [framingBusy, setFramingBusy] = useState(false);

  const refetch = useCallback(async () => {
    try {
      const d = await api<ProjectData>(`/api/projects/${projectId}`);
      setProject(d.project);
      if (d.inputs) setInputs(d.inputs);
      setSource(d.source);
      setClips(d.clips);
      if (d.renders) setRenders(d.renders);
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
      await api("/api/jobs", { method: "POST", json: { type, sourceVideoId: source.id, ...(type === "autoclip" ? { renderClips: renderCount } : {}) } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the job");
    } finally {
      setStarting(null);
    }
  }

  /** How clips are made vertical. Clips that were already framed are re-framed in the background. */
  async function setFraming(framing: Framing) {
    if (!source || source.framing === framing) return;
    const before = source;
    setSource({ ...source, framing });
    setFramingBusy(true);
    setError(null);
    try {
      const r = await api<{ source: SourceVideo; reframed: number }>(`/api/sources/${source.id}`, { method: "PATCH", json: { framing } });
      setSource(r.source);
      void refetch();
    } catch (e) {
      setSource(before);
      setError(e instanceof Error ? e.message : "Could not change the framing");
    } finally {
      setFramingBusy(false);
    }
  }

  async function exportClip(id: string) {
    setError(null);
    try {
      await api(`/api/clips/${id}/renders`, { method: "POST", json: {} });
      void refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the export");
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
            The background worker isn&apos;t running, so nothing will be processed. Start KLIPZ with{" "}
            <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs">npm start</code> (or double-click <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs">start-klipz.bat</code>); to run only the worker use{" "}
            <code className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs">npm run worker</code>.
          </p>
        </div>
      ) : null}

      {montage ? <MontagePanel project={project} inputs={inputs} jobs={jobs} onChange={() => void refetch()} /> : null}

      <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]", montage && "hidden")}>
        <SourceCard source={source} job={importJob(jobs)} />
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
            <strong className="font-semibold text-fg">Find clips</strong> lists the potential clips (more for a longer video, 15 to 60 seconds each).{" "}
            <strong className="font-semibold text-fg">AutoClip</strong> also edits and renders the best{" "}
            <select
              aria-label="How many clips AutoClip renders"
              value={renderCount}
              onChange={(e) => setRenderCount(Number(e.target.value))}
              className="h-6 rounded border border-line bg-bg px-1 text-xs text-fg"
              data-testid="render-count"
            >
              {[3, 5, 10, 20, 50].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>{" "}
            in one go; export any other clip with its Export button.
          </p>
          {source ? (
            <fieldset className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-3" disabled={framingBusy} data-testid="framing">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Vertical framing</legend>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent,#7c5cff)]"
                  checked={source.framing === "speaker"}
                  onChange={(e) => void setFraming(e.target.checked ? "speaker" : "center")}
                  data-testid="framing-speaker"
                />
                <span>
                  <span className="font-semibold">Keep the speaker centred</span>
                  <span className="block text-xs text-muted">
                    Follows the person who is talking when the video is cropped to 9:16. Turn it off for gameplay, screen recordings or anything where the action matters more than a face.
                  </span>
                </span>
              </label>
              {source.framing !== "speaker" ? (
                <div role="radiogroup" aria-label="Framing without speaker tracking" className="grid gap-2 sm:grid-cols-2">
                  {([
                    ["center", "Fill the screen", "The middle of the picture, cropped to 9:16."],
                    ["fit", "Show the whole picture", "Nothing is cut off; blurred bars above and below."],
                  ] as const).map(([id, label, hint]) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={source.framing === id}
                      onClick={() => void setFraming(id)}
                      className={cn("cursor-pointer rounded-lg border p-2 text-left", source.framing === id ? "border-accent bg-accent/10" : "border-line hover:bg-panel-2")}
                      data-testid={`framing-${id}`}
                    >
                      <span className="block text-xs font-bold">{label}</span>
                      <span className="block text-[11px] text-muted">{hint}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <p className="text-[11px] text-muted">Applies to this video's clips; already framed clips are re-framed. Any single clip can be cropped and positioned by hand in the editor (Video → Framing).</p>
            </fieldset>
          ) : null}
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
            <h2 className="text-lg font-bold">{montage ? "Montages" : "Clips"}</h2>
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
            montage ? (
              <EmptyState title="No montages yet" icon={<Scissors className="h-8 w-8" />}>
                Add your videos, choose how many montages and how long, then press “Make montages”.
              </EmptyState>
            ) : source?.status === "deleted" ? (
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
                <ClipCard key={c.id} clip={c} render={renders[c.id]} rank={rankOf.get(c.id) ?? 0} selected={c.id === selectedId} onSelect={() => setSelectedId(c.id)} onStatus={(s) => void patchClip(c.id, { status: s })} onExport={() => void exportClip(c.id)} montage={montage} />
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
                        <ClipCard key={c.id} clip={c} render={renders[c.id]} rank={rankOf.get(c.id) ?? 0} selected={c.id === selectedId} onSelect={() => setSelectedId(c.id)} onStatus={(s) => void patchClip(c.id, { status: s })} onExport={() => void exportClip(c.id)} montage={montage} />
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
              {montage ? (
                <MontagePreview url={renders[selected.id]?.status === "ready" ? fileUrl(renders[selected.id]!.storage_key) : null} clipId={selected.id} />
              ) : (
                <ClipPreview clip={selected} source={source} words={words} />
              )}
              {source?.status === "ready" && !montage ? (
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

/** A montage jumps between scenes, so the page shows its export (the editor previews edits live). */
function MontagePreview({ url, clipId }: { url: string | null; clipId: string }) {
  return url ? (
    <video src={url} controls playsInline className="mx-auto aspect-[9/16] w-full max-w-[320px] rounded-lg bg-black" data-testid="montage-preview" />
  ) : (
    <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-muted">
      Rendering… <a className="font-semibold text-accent-2 underline" href={`/clips/${clipId}`}>Open it in the editor</a> to watch it now.
    </p>
  );
}
