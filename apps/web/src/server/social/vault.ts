import { decryptToken, encryptToken, ensureFreshTokens, type Publisher, type PublisherContext, type TokenSet } from "@klipz/publishers";
import { get, run, nowIso } from "../db";
import { encryptionKey } from "./config";

// Tokens exist in plaintext only inside the server process, briefly. Columns
// hold AES-256-GCM ciphertext. Nothing here is ever serialised to a client.

export const seal = (plain: string, key: string = encryptionKey()): string => encryptToken(plain, key);
export const unseal = (enc: string, key: string = encryptionKey()): string => decryptToken(enc, key);

interface TokenRow {
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  scopes: string | null;
}

/** Encrypted column values for a token set (empty access token = aggregator account, stored as null). */
export function sealTokens(tokens: TokenSet, key: string = encryptionKey()): { access: string | null; refresh: string | null; expiresAt: string | null; scopes: string } {
  return {
    access: tokens.accessToken ? encryptToken(tokens.accessToken, key) : null,
    refresh: tokens.refreshToken ? encryptToken(tokens.refreshToken, key) : null,
    expiresAt: tokens.expiresAt ?? null,
    scopes: JSON.stringify(tokens.scopes ?? []),
  };
}

export function loadTokens(accountId: string, key: string = encryptionKey()): TokenSet | undefined {
  const r = get<TokenRow>("select access_token_enc, refresh_token_enc, token_expires_at, scopes from social_accounts where id = ?", accountId);
  if (!r) return undefined;
  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.scopes ?? "[]");
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* ignore */
  }
  const tokens: TokenSet = { accessToken: r.access_token_enc ? decryptToken(r.access_token_enc, key) : "", scopes };
  if (r.refresh_token_enc) tokens.refreshToken = decryptToken(r.refresh_token_enc, key);
  if (r.token_expires_at) tokens.expiresAt = r.token_expires_at;
  return tokens;
}

const g = globalThis as unknown as { __klipzTokenLocks?: Map<string, Promise<unknown>> };
const tokenLocks: Map<string, Promise<unknown>> = (g.__klipzTokenLocks ??= new Map());

/** Run `fn` with no other withAccountLock(accountId) call running at the same time in this process. */
export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tokenLocks.get(accountId) ?? Promise.resolve();
  const task = prev.catch(() => undefined).then(fn);
  const tail = task.catch(() => undefined);
  tokenLocks.set(accountId, tail);
  try {
    return await task;
  } finally {
    if (tokenLocks.get(accountId) === tail) tokenLocks.delete(accountId);
  }
}

/**
 * Stored tokens for an account, refreshed first when they are about to expire (undefined when none
 * are stored). One refresh per account at a time: refresh tokens may rotate (X accepts each one only
 * once), so two parallel refreshes with the same token would fail one of them and flag the account
 * for reconnection. Tokens are re-read inside the lock, so a waiting caller uses the new ones.
 */
export function freshTokens(accountId: string, publisher: Publisher, ctx: PublisherContext, key?: string): Promise<TokenSet | undefined> {
  return withAccountLock(accountId, async () => {
    const stored = loadTokens(accountId, key);
    if (!stored) return undefined;
    const fresh = await ensureFreshTokens(publisher, ctx, stored);
    if (fresh.refreshed) saveTokens(accountId, fresh.tokens, key); // persist rotated tokens immediately
    return fresh.tokens;
  });
}

/** Persist a (rotated) token set. A missing refresh token keeps the stored one. */
export function saveTokens(accountId: string, tokens: TokenSet, key: string = encryptionKey()): void {
  const s = sealTokens(tokens, key);
  run(
    `update social_accounts set access_token_enc = ?, refresh_token_enc = coalesce(?, refresh_token_enc), token_expires_at = ?,
       scopes = case when ? = '[]' then scopes else ? end, updated_at = ? where id = ?`,
    s.access,
    s.refresh,
    s.expiresAt,
    s.scopes,
    s.scopes,
    nowIso(),
    accountId,
  );
}
