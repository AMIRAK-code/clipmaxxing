import { notFound } from "next/navigation";
import { ClipEditorLoader } from "@/components/editor/editor-loader";
import { clipDetail } from "@/server/clips";
import { jobsForProject } from "@/server/jobs";
import { renderViews } from "@/server/renders";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit clip · KLIPZ" };

export default async function ClipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = clipDetail(id);
  if (!detail) notFound();
  const { clip, source, words } = detail;
  return (
    <ClipEditorLoader
      clip={clip}
      source={source}
      words={words}
      initialRenders={renderViews(id)}
      initialJobs={jobsForProject(clip.project_id, 30)}
    />
  );
}
