import { body, HttpError, notFound, ok, route } from "@/server/http";
import { enqueueJob } from "@/server/jobs";
import { getProject, montageInputs } from "@/server/repo";
import { MontageSettings } from "@/lib/montage";

export const dynamic = "force-dynamic";

/** Make montages: cuts the scene pool when the videos changed, then adds `count` new montages. */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const project = getProject(id) ?? notFound();
  if (project.kind !== "montage") throw new HttpError(400, "This project is not a montage");
  const input = await body(req, MontageSettings.partial());
  const inputs = montageInputs(id);
  if (inputs.some((s) => s.status === "uploading")) throw new HttpError(409, "Wait for the uploads to finish");
  if (!inputs.some((s) => s.status !== "failed")) throw new HttpError(400, "Add at least one video first");
  const opts = project.options ?? {};
  const count = input.count ?? opts.count ?? 3;
  const minSec = input.minSec ?? opts.minSec ?? 10;
  const maxSec = Math.max(minSec, input.maxSec ?? opts.maxSec ?? 20);
  const job = enqueueJob("montage", { project_id: id, count, minSec, maxSec }, { projectId: id, dedupeKey: `montage:${id}` });
  return ok({ job });
});
