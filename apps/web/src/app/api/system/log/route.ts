import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { logError } from "@/server/log";

export const dynamic = "force-dynamic";

/** The error boundary reports client-side crashes here -> <data dir>/logs/web.log */
export const POST = route(async (req) => {
  const b = await body(req, z.object({ message: z.string().max(2000), digest: z.string().max(100).optional(), where: z.string().max(300).optional() }));
  logError(`client ${b.where ?? ""}`.trim(), `${b.message}${b.digest ? ` (digest ${b.digest})` : ""}`);
  return ok({ logged: true });
});
