import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { runLibraryAction } from "@/server/library";

export const dynamic = "force-dynamic";

const schema = z.object({
  action: z.enum(["reveal", "open", "copy"]),
  target: z.union([
    z.object({ kind: z.enum(["raw", "clip"]), id: z.string().min(1).max(64) }),
    z.object({ kind: z.literal("folder"), id: z.enum(["library", "raw", "clips"]) }),
  ]),
});

/** Show in Explorer / open / copy a library file. Targets are ids, never paths from the browser. */
export const POST = route(async (req) => {
  const { action, target } = await body(req, schema);
  return ok(await runLibraryAction(action, target));
});
