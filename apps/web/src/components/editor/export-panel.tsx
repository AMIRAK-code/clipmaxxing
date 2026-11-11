"use client";

import type { Job } from "@klipz/shared";
import { AlertTriangle, Check, Download, Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Progress, Switch } from "@/components/ui/primitives";
import { useJobs } from "@/hooks/use-jobs";
import { api, cn, fileUrl, formatBytes, formatDuration } from "@/lib/utils";
import type { RenderView } from "@/server/renders";
import { Row, Section } from "./controls";
import { useEditorCtx, useSaveState } from "./editor-context";

const PROVIDER_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
  facebook: "Facebook",
  x: "X",
  linkedin: "LinkedIn",
};

export function ExportPanel({ initialRenders, initialJobs }: { initialRenders: RenderView[]; initialJobs: Job[] }) {
  const ctx = useEditorCtx();
  const saveState = useSaveState();
  const [renders, setRenders] = useState(initialRenders);
  const [denoise, setDenoise] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await api<{ renders: RenderView[] }>(`/api/clips/${ctx.clip.id}/renders`);
      setRenders(d.renders);
    } catch {
      /* the next job event retries */
    }
  }, [ctx.clip.id]);

  const { jobs, workerAlive } = useJobs(ctx.clip.projectId, initialJobs, (job) => {
    if (job.type === "render") void refresh();
  });

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await ctx.saveNow();
      if (!saved) throw new Error("Could not save your latest edits. Fix that, then export again.");
      await api(`/api/clips/${ctx.clip.id}/renders`, { method: "POST", json: { denoise } });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const version = ctx.autosaver.current?.currentVersion;
  const unsaved = saveState.status !== "saved";
  const jobFor = (r: RenderView): Job | undefined => jobs.find((j) => j.type === "render" && j.payload.render_id === r.id);
  const [latest, ...older] = renders;
  const inFlight = latest && (latest.status === "queued" || latest.status === "rendering");

  return (
    <div>
      <Section title="Export 1080×1920 MP4">
        <Row label="Denoise audio">
          <Switch checked={denoise} onChange={setDenoise} label="Denoise audio" />
        </Row>
        <Button onClick={() => void start()} disabled={busy} data-testid="export-start">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}
          {inFlight ? "Rendering…" : "Export clip"}
        </Button>
        {unsaved ? <p className="text-xs text-warn">Unsaved edits are saved automatically before the export starts.</p> : null}
        {workerAlive === false ? (
          <p className="text-xs text-warn">The worker is offline. The render is queued and starts when you run <code className="rounded bg-panel-2 px-1">npm run worker</code>.</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-bad">
            {error}
          </p>
        ) : null}
      </Section>

      {latest ? (
        <RenderCard
          key={latest.id}
          render={latest}
          job={jobFor(latest)}
          outdated={latest.edit_version !== version || unsaved}
          onRetry={() => void start()}
        />
      ) : (
        <p className="px-3 py-4 text-xs text-muted">No renders yet.</p>
      )}

      {older.length > 0 ? (
        <Section title="Earlier renders">
          <ul className="flex flex-col gap-1">
            {older.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-line px-2 py-1.5 text-xs">
                <span className="text-muted">
                  {new Date(r.created_at).toLocaleString()} · {r.status}
                </span>
                {r.status === "ready" && r.storage_key ? (
                  <a className="font-semibold text-accent-2 hover:underline" href={`${fileUrl(r.storage_key)}?download`}>
                    Download
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function RenderCard({ render, job, outdated, onRetry }: { render: RenderView; job: Job | undefined; outdated: boolean; onRetry: () => void }) {
  const url = fileUrl(render.storage_key);
  return (
    <Section
      title="Latest render"
      action={
        <span className="flex items-center gap-1.5">
          {outdated ? <Badge tone="warn" data-testid="outdated-badge">Outdated</Badge> : null}
          <Badge tone={render.status === "ready" ? "good" : render.status === "failed" ? "bad" : "accent"} data-testid="render-status">
            {render.status}
          </Badge>
        </span>
      }
    >
      {render.status === "queued" || render.status === "rendering" ? (
        <div className="flex flex-col gap-2" data-testid="render-progress">
          <Progress value={job?.progress ?? 0} />
          <p className="text-xs text-muted">
            {job ? `${Math.round(job.progress * 100)}%${job.stage ? ` · ${job.stage}` : ""}` : "Waiting for the worker…"}
            {job?.status === "queued" ? " · queued" : ""}
          </p>
        </div>
      ) : null}

      {render.status === "failed" ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="flex items-start gap-1.5 text-xs text-bad">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {render.error ?? job?.error ?? "The render failed."}
          </p>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
          </Button>
        </div>
      ) : null}

      {render.status === "ready" && url ? (
        <>
          <video src={url} controls preload="metadata" className="mx-auto max-h-64 rounded-md bg-black" aria-label="Rendered clip preview" />
          <a
            href={`${url}?download`}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-2"
            data-testid="render-download"
          >
            <Download className="h-4 w-4" aria-hidden /> Download MP4
          </a>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <Fact k="Duration" v={formatDuration(render.duration_sec)} />
            <Fact k="Size" v={formatBytes(render.size_bytes)} />
            <Fact k="Resolution" v={render.width && render.height ? `${render.width}×${render.height}` : "–"} />
            <Fact k="Frame rate" v={render.fps ? `${Math.round(render.fps)} fps` : "–"} />
            <Fact k="Loudness" v={render.lufs != null ? `${render.lufs.toFixed(1)} LUFS` : "–"} />
            <Fact k="Codec" v={[render.video_codec, render.audio_codec].filter(Boolean).join(" / ") || "–"} />
          </dl>
          {render.platforms ? (
            <div className="flex flex-col gap-1.5" data-testid="platform-checks">
              <h4 className="text-[11px] font-bold uppercase tracking-wide text-muted">Platform limits</h4>
              {render.platforms.map((p) => (
                <div key={p.provider} className="flex items-start gap-2 text-xs" data-provider={p.provider} data-ok={p.ok}>
                  {p.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" aria-hidden /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bad" aria-hidden />}
                  <span className="w-20 shrink-0 font-semibold">{PROVIDER_LABEL[p.provider] ?? p.provider}</span>
                  <span className={cn("min-w-0", p.ok ? "text-muted" : "text-bad")}>{p.ok ? (p.warnings[0] ?? "File meets the limits") : p.errors.join(" ")}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="text-right tabular-nums">{v}</dd>
    </>
  );
}
