import { ok, route } from "@/server/http";
import { enqueueJob } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** Queue the worker's cleanup job (expired source media, stale partial uploads, old finished jobs). Dedupes while one is queued/running. */
export const POST = route(() => ok({ job: enqueueJob("cleanup", {}, { dedupeKey: "cleanup:manual", maxAttempts: 2 }) }));
