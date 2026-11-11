import { ok, route } from "@/server/http";
import { listAccounts } from "@/server/repo";
import { aggregator, providerStatus, sandboxMode } from "@/server/social/config";

export const dynamic = "force-dynamic";

/** {accounts (no token fields), providers: {[provider]: {configured, missing, viaAggregator, redirectUri}}, sandbox, aggregator} */
export const GET = route(() => {
  const agg = aggregator();
  return ok({
    accounts: listAccounts(),
    providers: providerStatus(),
    sandbox: sandboxMode(),
    aggregator: agg ? { kind: agg.kind, providers: agg.providers } : null,
  });
});
