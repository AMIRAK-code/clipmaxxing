import { z } from "zod";
import { HttpError, ok, route } from "@/server/http";
import { sandboxMode } from "@/server/social/config";
import { processDuePosts } from "@/server/social/engine";
import { pullMetrics } from "@/server/social/metrics";

export const dynamic = "force-dynamic";

const Body = z.object({ metrics: z.boolean().optional(), force: z.boolean().optional(), now: z.string().datetime({ offset: true }).optional() }).default({});

/**
 * Manual trigger (same-origin POST) for "Run now" and tests. Body (optional):
 * {metrics?: boolean, force?: boolean} also pulls metrics (force overwrites today's snapshot); {now?: ISO} overrides the clock (sandbox mode only).
 */
export const POST = route(async (req) => {
  let raw: unknown = {};
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Invalid body");
  if (parsed.data.now && !sandboxMode()) throw new HttpError(403, "Clock override is only available in sandbox mode");
  const now = parsed.data.now ? new Date(parsed.data.now) : new Date();
  const tick = await processDuePosts(now);
  const metrics = parsed.data.metrics ? await pullMetrics(now, {}, { force: parsed.data.force }) : undefined;
  return ok({ now: now.toISOString(), tick, ...(metrics ? { metrics } : {}) });
});
