import { Shuffle } from "lucide-react";
import Link from "next/link";
import { NewMontage } from "@/components/new-montage";
import { Card, EmptyState } from "@/components/ui/primitives";
import { fileUrl } from "@/lib/utils";
import { listProjects, montageInputs } from "@/server/repo";

export const dynamic = "force-dynamic";
export const metadata = { title: "Montage · KLIPZ" };

export default function MontagePage() {
  const projects = listProjects("montage").map((p) => ({ ...p, inputs: montageInputs(p.id) }));
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-black tracking-tight">Montage</h1>
        <p className="text-sm text-muted">
          Drop in several videos. KLIPZ cuts the moments where something happens in each one and mixes them into short videos.
        </p>
      </header>
      <NewMontage />
      {projects.length === 0 ? (
        <EmptyState title="No montages yet" icon={<Shuffle className="h-8 w-8" />}>
          Add two or more videos above to make your first montages.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const first = p.inputs.find((s) => s.status === "ready");
            const thumb = first ? fileUrl(`sources/${first.id}/thumb.jpg`) : null;
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="group">
                <Card className="overflow-hidden transition-colors group-hover:border-accent/60">
                  <div className="relative aspect-video bg-panel-2">
                    {thumb ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : (
                      <div className="grid h-full place-items-center text-muted">
                        <Shuffle className="h-8 w-8" />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 p-3">
                    <p className="truncate font-semibold">{p.title}</p>
                    <p className="text-xs text-muted">
                      {p.inputs.length} video{p.inputs.length === 1 ? "" : "s"} · {p.clip_count} montage{p.clip_count === 1 ? "" : "s"}
                    </p>
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
