import type { Provider, SocialAccount } from "@klipz/shared";
import { PROVIDERS } from "@klipz/shared";
import type { AccountInfo, ConnectResult } from "@klipz/publishers";
import { get, newId, nowIso, run, tx } from "../db";
import { HttpError } from "../http";
import { getAccount } from "../repo";
import { sandboxMode } from "./config";
import { sandboxAccountMeta } from "./mock";
import { sealTokens } from "./vault";

/**
 * Insert or update every account a connect() returned. Per-account tokens
 * (Facebook pages) win over the user token. Reconnecting an existing account
 * reactivates it and keeps its refresh token when the provider sent none.
 */
export function upsertAccounts(provider: Provider, result: ConnectResult, opts: { viaAggregator?: boolean } = {}): SocialAccount[] {
  const ids: string[] = [];
  tx(() => {
    for (const info of result.accounts) {
      const tokens = result.accountTokens?.[info.externalAccountId] ?? result.tokens;
      const s = sealTokens(tokens);
      const existing = get<{ id: string }>("select id from social_accounts where provider = ? and external_account_id = ?", provider, info.externalAccountId);
      const id = existing?.id ?? newId();
      if (existing) {
        run(
          `update social_accounts set display_name = ?, username = ?, avatar_url = ?, scopes = ?, access_token_enc = ?,
             refresh_token_enc = coalesce(?, refresh_token_enc), token_expires_at = ?, status = 'active', via_aggregator = ?,
             meta = ?, last_error = null, updated_at = ? where id = ?`,
          info.displayName,
          info.username ?? null,
          info.avatarUrl ?? null,
          s.scopes,
          s.access,
          s.refresh,
          s.expiresAt,
          opts.viaAggregator ? 1 : 0,
          JSON.stringify(info.meta ?? {}),
          nowIso(),
          id,
        );
      } else {
        run(
          `insert into social_accounts (id, provider, external_account_id, display_name, username, avatar_url, scopes,
             access_token_enc, refresh_token_enc, token_expires_at, status, via_aggregator, meta)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          id,
          provider,
          info.externalAccountId,
          info.displayName,
          info.username ?? null,
          info.avatarUrl ?? null,
          s.scopes,
          s.access,
          s.refresh,
          s.expiresAt,
          opts.viaAggregator ? 1 : 0,
          JSON.stringify(info.meta ?? {}),
        );
      }
      ids.push(id);
    }
  });
  return ids.map((id) => getAccount(id)!).filter(Boolean);
}

/** Row → publisher AccountInfo (no tokens). */
export function accountInfoOf(a: SocialAccount): AccountInfo {
  return {
    externalAccountId: a.external_account_id,
    displayName: a.display_name,
    ...(a.username ? { username: a.username } : {}),
    ...(a.avatar_url ? { avatarUrl: a.avatar_url } : {}),
    meta: a.meta ?? {},
  };
}

export function createSandboxAccount(provider: string): SocialAccount {
  if (!sandboxMode()) throw new HttpError(403, "Sandbox mode is off (set KLIPZ_PUBLISH_MOCK=1)");
  if (!(PROVIDERS as string[]).includes(provider)) throw new HttpError(400, "Unknown provider");
  const p = provider as Provider;
  const info: AccountInfo = {
    externalAccountId: `sandbox-${p}`,
    displayName: `Sandbox ${p[0]!.toUpperCase()}${p.slice(1)}`,
    username: `sandbox_${p}`,
    meta: sandboxAccountMeta(p),
  };
  return upsertAccounts(p, { tokens: { accessToken: "sandbox-access-token", refreshToken: "sandbox-refresh-token", scopes: [] }, accounts: [info] })[0]!;
}

/** Disconnect: delete the row. posts.social_account_id is set null by the FK, history stays. */
export function disconnectAccount(id: string): boolean {
  return run("delete from social_accounts where id = ?", id).changes > 0;
}

export function markNeedsReconnect(accountId: string, message: string): void {
  run("update social_accounts set status = 'needs_reconnect', last_error = ?, updated_at = ? where id = ?", message.slice(0, 500), nowIso(), accountId);
}
