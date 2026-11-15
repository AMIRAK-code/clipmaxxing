import type { Job, SourceVideo } from "@klipz/shared";
import { Film } from "lucide-react";
import { Badge, Card, Progress } from "@/components/ui/primitives";
import { fileUrl, formatBytes, formatDuration } from "@/lib/utils";

export const SOURCE_STATUS: Record<string, { label: string; tone: "default" | "good" | "warn" | "bad" }> = {
  pending: { label: "Queued", tone: "default" },
  uploading: { label: "Uploading", tone: "warn" },
  importing: { label: "Importing", tone: "warn" },
  ready: { label: "Ready", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  deleted: { label: "Source removed", tone: "default" },
};

/** The import job (upload ingest or YouTube download) that is still working on this source, if any. */
export function importJob(jobs: Job[]): Job | null {
  return jobs.find((j) => (j.type === "ingest" || j.type === "import_youtube") && (j.status === "queued" || j.status === "running")) ?? null;
}

export function SourceCard({ source, job = null }: { source: SourceVideo | null; job?: Job | null }) {
  if (!source) {
    return (
      <Card className="p-4 text-sm text-muted" role="status">
        This project has no source video.
      </Card>
    );
  }
  // "Queued" is only true until the worker picks the job up; after that say what is happening.
  const working = job?.status === "running" && source.status !== "ready" && source.status !== "failed";
  const st = working ? { label: "Importing", tone: "warn" as const } : (SOURCE_STATUS[source.status] ?? SOURCE_STATUS.pending!);
  const thumb = source.status === "ready" ? fileUrl(`sources/${source.id}/thumb.jpg`) : null;
  return (
    <Card className="flex gap-4 p-3">
      <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-lg bg-panel-2">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="Source video thumbnail" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-muted">
            <Film className="h-7 w-7" aria-hidden />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Badge tone={st.tone}>{st.label}</Badge>
          <span className="truncate text-sm font-semibold">{source.filename ?? source.source_url ?? "Source video"}</span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted">
          <dt>Duration</dt>
          <dd className="text-fg">{formatDuration(source.duration_sec)}</dd>
          <dt>Resolution</dt>
          <dd className="text-fg">{source.width && source.height ? `${source.width}×${source.height}${source.fps ? ` @ ${Math.round(source.fps)} fps` : ""}` : "–"}</dd>
          <dt>Size</dt>
          <dd className="text-fg">{formatBytes(source.size_bytes)}</dd>
        </dl>
        {working && job ? (
          <div className="mt-1 flex flex-col gap-1" aria-live="polite">
            <Progress value={job.progress} />
            <p className="truncate text-xs text-muted">
              {job.stage ?? "Starting"} · {Math.round(job.progress * 100)}%
            </p>
          </div>
        ) : null}
        {!working && job?.status === "queued" ? <p className="text-xs text-muted">Waiting for the worker to finish what it is doing.</p> : null}
        {source.status === "failed" && source.error ? (
          <p role="alert" className="break-words text-xs text-bad">
            {source.error}
          </p>
        ) : null}
        {source.status === "deleted" ? (
          <p className="text-xs text-warn">The video file was cleaned up to save space. Existing clips and renders stay, but the source can&apos;t be previewed or re-analysed.</p>
        ) : null}
      </div>
    </Card>
  );
}
