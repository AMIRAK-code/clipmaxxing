import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { createSandboxAccount } from "@/server/social/accounts";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const { provider } = await body(req, z.object({ provider: z.string() }));
  return ok({ account: createSandboxAccount(provider) });
});
