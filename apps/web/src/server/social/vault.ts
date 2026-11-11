import { decryptToken, encryptToken, type TokenSet } from "@klipz/publishers";
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
