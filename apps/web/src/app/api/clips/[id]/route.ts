import { applyClipPatch, ClipPatchSchema, clipDetail, deleteClip } from "@/server/clips";
import { body, notFound, ok, route } from "@/server/http";
import { rendersForClip } from "@/server/repo";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>((_req, { id }) => {
  const d = clipDetail(id) ?? notFound("Clip not found");
  return ok({ ...d, renders: rendersForClip(id) });
});

export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const patch = await body(req, ClipPatchSchema);
  const { clip, reframeQueued } = applyClipPatch(id, patch);
  return ok({ clip, reframeQueued });
});

export const DELETE = route<{ id: string }>((_req, { id }) => {
  if (!deleteClip(id)) notFound("Clip not found");
  return ok({ deleted: true });
});
