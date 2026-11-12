import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { testAi } from "@/server/ai-settings";

export const dynamic = "force-dynamic";

/** Check a provider with the saved settings; returns {ok, message, models?}. */
export const POST = route(async (req) => {
  const { which } = await body(req, z.object({ which: z.enum(["anthropic", "openai", "ollama"]) }));
  return ok(await testAi(which));
});
