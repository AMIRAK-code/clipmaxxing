import { notFound, ok, route } from "@/server/http";
import { disconnectAccount } from "@/server/social/accounts";

export const dynamic = "force-dynamic";

export const DELETE = route<{ id: string }>((_req, { id }) => {
  if (!disconnectAccount(id)) notFound("Account not found");
  return ok({ disconnected: true });
});
