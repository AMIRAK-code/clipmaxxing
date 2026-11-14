import { FRAMINGS } from "@klipz/shared";
import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { setSourceFraming } from "@/server/framing";

export const dynamic = "force-dynamic";

const Patch = z.object({ framing: z.enum(FRAMINGS as [string, ...string[]]) }).strict();

/** PATCH {framing} → how clips of this video are made vertical; clips that were already framed are re-framed. */
export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const { framing } = await body(req, Patch);
  return ok(setSourceFraming(id, framing as (typeof FRAMINGS)[number]));
});
