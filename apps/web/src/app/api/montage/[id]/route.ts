import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { makeMoreMontages, montageDetail, remixMontage, startMontage, updateMontageSettings } from "@/server/montage";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>((_req, { id }) => ok(montageDetail(id)));

const Patch = z.object({
  count: z.number().int().min(1).max(20).optional(),
  minSec: z.number().min(5).max(60).optional(),
  maxSec: z.number().min(5).max(60).optional(),
});

export const PATCH = route<{ id: string }>(async (req, { id }) => ok({ project: updateMontageSettings(id, await body(req, Patch)) }));

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("more"), count: z.number().int().min(1).max(20) }),
  z.object({ action: z.literal("remix"), clipId: z.string().uuid() }),
]);

/**
 * start: queue the montage job (after the uploads); more: add montages from the pool;
 * remix: a new random set of scenes for one montage. more / remix queue the renders.
 */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const a = await body(req, Action);
  if (a.action === "start") return ok({ job: startMontage(id) }, { status: 201 });
  if (a.action === "more") return ok({ montages: makeMoreMontages(id, a.count) }, { status: 201 });
  return ok({ montage: remixMontage(a.clipId) });
});
