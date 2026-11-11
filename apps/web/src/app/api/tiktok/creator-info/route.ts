import { HttpError, ok, route } from "@/server/http";
import { creatorInfoFor } from "@/server/social/tiktok";

export const dynamic = "force-dynamic";

/** GET /api/tiktok/creator-info?accountId= -> {creatorInfo, consent, sandbox} */
export const GET = route(async (req) => {
  const accountId = new URL(req.url).searchParams.get("accountId");
  if (!accountId) throw new HttpError(400, "accountId is required");
  return ok(await creatorInfoFor(accountId));
});
