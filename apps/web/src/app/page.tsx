import { Film } from "lucide-react";
import Link from "next/link";
import { NewProject } from "@/components/new-project";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { fileUrl, formatDuration } from "@/lib/utils";
import { listProjects } from "@/server/repo";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; tone: "default" | "good" | "warn" | "bad" | "accent" }> = {
  pending: { label: "Queued", tone: "default" },
  uploading: { label: "Uploading", tone: "warn" },
  importing: { label: "Importing", tone: "warn" },
  ready: { label: "Ready", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  deleted: { label: "Source removed", tone: "default" },
};

export default function Dashboard() {
  const projects = listProjects();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-black tracking-tight">Projects</h1>
        <p className="text-sm text-muted">Drop in a long video. KLIPZ finds the best moments, reframes them to 9:16 and captions them.</p>
      </header>
      <NewProject />
      {projects.length === 0 ? (
        <EmptyState title="No projects yet" icon={<Film className="h-8 w-8" />}>
          Upload a video or paste a YouTube link above to make your first clips.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const st = STATUS[p.source?.status ?? "pending"] ?? STATUS.pending!;
            const thumb = p.source?.status === "ready" ? fileUrl(`sources/${p.source.id}/thumb.jpg`) : null;
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="group">
                <Card className="overflow-hidden transition-colors group-hover:border-accent/60">
                  <div className="relative aspect-video bg-panel-2">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className="grid h-full place-items-center text-muted">
                        <Film className="h-8 w-8" />
                      </div>
                    )}
                    <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-semibold">
                      {formatDuration(p.source?.duration_sec)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 p-3">
                    <p className="truncate font-semibold">{p.title}</p>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <Badge tone={st.tone}>{st.label}</Badge>
                      <span>
                        {p.clip_count} clip{p.clip_count === 1 ? "" : "s"}
                      </span>
                      {p.top_score != null ? <span>· top score {Math.round(p.top_score)}</span> : null}
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
