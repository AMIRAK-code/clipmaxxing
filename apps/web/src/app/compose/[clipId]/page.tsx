import { notFound } from "next/navigation";
import { Composer } from "@/components/composer/composer";
import { listAccounts, getClip } from "@/server/repo";
import { renderViews } from "@/server/renders";
import { sandboxMode } from "@/server/social/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Post clip · KLIPZ" };

export default async function ComposePage({ params }: { params: Promise<{ clipId: string }> }) {
  const { clipId } = await params;
  const clip = getClip(clipId);
  if (!clip) notFound();
  return (
    <Composer
      clip={{ id: clip.id, title: clip.title, hook: clip.hook, edit_version: clip.edit_version, project_id: clip.project_id }}
      renders={renderViews(clip.id)}
      accounts={listAccounts()}
      sandbox={sandboxMode()}
    />
  );
}
