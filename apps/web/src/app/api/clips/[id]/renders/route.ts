import { z } from "zod";
import { HttpError, ok, route } from "@/server/http";
import { createRender, renderViews } from "@/server/renders";

export const dynamic = "force-dynamic";

const Body = z.object({ denoise: z.boolean().optional() }).strict();

/** GET → every render of the clip (newest first) with per-platform checks for ready ones. */
export const GET = route<{ id: string }>((_req, { id }) => ok({ renders: renderViews(id) }));

/** POST {denoise?} → queue a render of the current edit version (or return the in-flight one). */
export const POST = route<{ id: string }>(async (req, { id }) => {
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, "Body must be JSON");
    }
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid body");
  const { render, job, reused } = createRender(id, parsed.data);
  return ok({ render, job, reused }, { status: reused ? 200 : 201 });
});
