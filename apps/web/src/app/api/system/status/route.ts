import { ok, route } from "@/server/http";
import { systemStatus } from "@/server/data-admin";
import { readLogTail } from "@/server/log";

export const dynamic = "force-dynamic";

/** Worker health (proxied from 127.0.0.1:8787/health), tool availability, data dir / disk use, scorer, which optional keys are set (names only). Also the tail of the local error log. */
export const GET = route(async () => ok({ status: await systemStatus(), logTail: readLogTail(30) }));
