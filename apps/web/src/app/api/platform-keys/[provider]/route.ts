import { z } from "zod";
import { body, ok, route } from "@/server/http";
import { deleteAppKeys, saveAppKeys } from "@/server/social/app-keys";
import { parseProvider } from "@/server/social/oauth";

export const dynamic = "force-dynamic";

// Write-only: developer-app keys entered on the Accounts page. Nothing here ever returns a secret.

const keysSchema = z.object({
  clientId: z.string().trim().min(1, "required").max(512),
  clientSecret: z.string().trim().min(1, "required").max(1024),
});

export const PUT = route<{ provider: string }>(async (req, { provider }) => {
  const p = parseProvider(provider);
  const { clientId, clientSecret } = await body(req, keysSchema);
  saveAppKeys(p, clientId, clientSecret);
  return ok({ saved: true });
});

export const DELETE = route<{ provider: string }>((_req, { provider }) => {
  return ok({ deleted: deleteAppKeys(parseProvider(provider)) });
});
