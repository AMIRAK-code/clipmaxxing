import { Layers } from "lucide-react";
import Link from "next/link";
import { NewMontage } from "@/components/montage/new-montage";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { fileUrl } from "@/lib/utils";
import { listMontageProjects } from "@/server/montage";

export const dynamic = "force-dynamic";

export default function MontagePage() {
  const projects = listMontageProjects();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-black tracking-tight">Montage</h1>
        <p className="text-sm text-muted">
          Drop in several videos. KLIPZ cuts the moments where something happens or something interesting is said, and mixes them into short vertical videos.
        </p>
      </header>
      <NewMontage />
      {projects.length === 0 ? (
        <EmptyState title="No montages yet" icon={<Layers className="h-8 w-8" />}>
          Add a few videos above to make your first montages.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {projects.map((p) => {
            const running = p.job && (p.job.status === "queued" || p.job.status === "running");
            const failed = p.job && (p.job.status === "failed" || p.job.status === "dead");
            const thumb = p.pool ? fileUrl(`sources/${p.pool.id}/thumb.jpg`) : null;
            return (
              <Link key={p.id} href={`/montage/${p.id}`} className="group">
                <Card className="overflow-hidden transition-colors group-hover:border-accent/60">
                  <div className="relative aspect-[9/16] max-h-72 w-full bg-panel-2">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className="grid h-full place-items-center text-muted">
                        <Layers className="h-8 w-8" />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 p-3">
                    <p className="truncate font-semibold">{p.title}</p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      {running ? <Badge tone="warn">Working</Badge> : failed ? <Badge tone="bad">Failed</Badge> : p.montage_count ? <Badge tone="good">Ready</Badge> : <Badge>Waiting</Badge>}
                      <span>
                        {p.inputs} video{p.inputs === 1 ? "" : "s"} · {p.montage_count} montage{p.montage_count === 1 ? "" : "s"}
                      </span>
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
