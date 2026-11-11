import { notFound } from "next/navigation";
import { ProjectView } from "@/components/project/project-view";
import { jobsForProject, workerHeartbeat } from "@/server/jobs";
import { clipsForProject, getProject, sourceForProject } from "@/server/repo";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) notFound();
  return (
    <ProjectView
      initial={{ project, source: sourceForProject(id) ?? null, clips: clipsForProject(id), jobs: jobsForProject(id, 20) }}
      initialWorkerAlive={workerHeartbeat().alive}
    />
  );
}
