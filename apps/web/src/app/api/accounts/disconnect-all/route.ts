import { ok, route } from "@/server/http";
import { disconnectAllAccounts } from "@/server/data-admin";

export const dynamic = "force-dynamic";

/** Remove every connected account and its stored tokens. Post history is kept. -> {disconnected: n} */
export const POST = route(() => ok({ disconnected: disconnectAllAccounts() }));
