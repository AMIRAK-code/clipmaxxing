import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { deleteAllData } from "@/server/data-admin";

export const dynamic = "force-dynamic";

/** POST {confirm: "DELETE"} -> disconnects accounts, wipes DB rows and the storage directory. */
export const POST = route(async (req) => {
  await body(req, z.object({ confirm: z.literal("DELETE") }));
  return ok({ result: deleteAllData() });
});
