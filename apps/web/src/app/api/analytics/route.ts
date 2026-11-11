import { ok, route } from "@/server/http";
import { analytics } from "@/server/social/analytics";

export const dynamic = "force-dynamic";

export const GET = route((req) => ok(analytics(Number(new URL(req.url).searchParams.get("days") ?? 30))));
