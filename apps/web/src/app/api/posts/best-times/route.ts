import { HttpError, ok, route } from "@/server/http";
import { suggestBestTimes, parseProviders } from "@/server/social/best-times";
import { isValidTimeZone } from "@/server/social/posts";

export const dynamic = "force-dynamic";

/** GET /api/posts/best-times?providers=youtube,x&timezone=Europe/Berlin -> {timezone, suggestions: {[provider]: {basis, sampleSize, slots[3]}}} */
export const GET = route((req) => {
  const q = new URL(req.url).searchParams;
  const timezone = q.get("timezone") || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!isValidTimeZone(timezone)) throw new HttpError(400, "Unknown IANA time zone");
  return ok({ timezone, suggestions: suggestBestTimes(parseProviders(q.get("providers")), timezone) });
});
