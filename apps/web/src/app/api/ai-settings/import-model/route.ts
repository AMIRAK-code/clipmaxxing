import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { aiSettingsView, importGguf, saveAiSettings } from "@/server/ai-settings";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

/** Import a .gguf file from this PC into Ollama and select it as the local model. */
export const POST = route(async (req) => {
  const { path, name } = await body(req, z.object({ path: z.string().trim().min(1).max(1024), name: z.string().trim().min(1).max(63) }));
  const done = await importGguf(path, name);
  saveAiSettings({ ollama: { model: done.model } });
  return ok({ ...done, settings: aiSettingsView() });
});
