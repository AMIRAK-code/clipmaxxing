import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { AI_PROVIDERS, aiSettingsView, saveAiSettings } from "@/server/ai-settings";

export const dynamic = "force-dynamic";

const key = z.string().trim().max(1024).nullable().optional();
const text = (max: number) => z.string().trim().max(max).optional();

const patchSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS).optional(),
    smartEdit: z.boolean().optional(),
    anthropic: z.object({ apiKey: key, model: text(120) }).strict().optional(),
    openai: z.object({ apiKey: key, baseUrl: text(300), model: text(200) }).strict().optional(),
    ollama: z.object({ url: text(300), model: text(200) }).strict().optional(),
    elevenlabs: z.object({ apiKey: key }).strict().optional(),
  })
  .strict();

/** Never returns a key: only whether one is saved. */
export const GET = route(() => ok(aiSettingsView()));

export const PUT = route(async (req) => {
  const patch = await body(req, patchSchema);
  for (const url of [patch.openai?.baseUrl, patch.ollama?.url]) {
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return ok({ error: "URLs must start with http:// or https://" }, { status: 400 });
  }
  saveAiSettings(patch as Parameters<typeof saveAiSettings>[0]);
  return ok(aiSettingsView());
});
