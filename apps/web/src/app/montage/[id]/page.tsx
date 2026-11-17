import { notFound } from "next/navigation";
import { MontageView } from "@/components/montage/montage-view";
import { workerHeartbeat } from "@/server/jobs";
import { getMontageProject, montageDetail } from "@/server/montage";

export const dynamic = "force-dynamic";

export default async function MontageProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getMontageProject(id)) notFound();
  return <MontageView initial={montageDetail(id)} initialWorkerAlive={workerHeartbeat().alive} />;
}
