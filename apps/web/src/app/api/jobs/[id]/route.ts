import { z } from "zod";
import { body, HttpError, notFound, ok, route } from "@/server/http";
import { cancelJob, getJob, retryJob } from "@/server/jobs";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>((_req, { id }) => ok({ job: getJob(id) ?? notFound() }));

export const POST = route<{ id: string }>(async (req, { id }) => {
  const { action } = await body(req, z.object({ action: z.enum(["retry", "cancel"]) }));
  if (!getJob(id)) notFound();
  const changed = action === "retry" ? retryJob(id) : cancelJob(id);
  if (!changed) throw new HttpError(409, `Job cannot be ${action === "retry" ? "retried" : "cancelled"} in its current state`);
  return ok({ job: getJob(id) });
});
