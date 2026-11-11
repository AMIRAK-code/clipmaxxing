import { createPkce, signState } from './crypto';
import { PublishError } from './errors';
import type { ConnectStart, Publisher, PublisherContext, TokenSet } from './types';
import { asRecord, nowOf, num, str } from './util';

export function buildAuthUrl(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

export function parseScopes(scope: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === 'string');
  if (typeof scope === 'string' && scope.trim()) return scope.split(/[\s,]+/).filter(Boolean);
  return fallback;
}

/** Build a TokenSet from a standard OAuth2 token response. */
export function tokenSetFromOAuth(
  ctx: PublisherContext,
  body: unknown,
  fallback: { refreshToken?: string; scopes?: string[] } = {},
): TokenSet {
  const b = asRecord(body);
  const accessToken = str(b.access_token);
  if (!accessToken) {
    throw new PublishError('Token endpoint did not return an access token', {
      code: 'auth_invalid',
      needsReconnect: true,
      providerPayload: redactTokenPayload(b),
    });
  }
  const tokens: TokenSet = { accessToken, scopes: parseScopes(b.scope, fallback.scopes ?? []) };
  const refreshToken = str(b.refresh_token) ?? fallback.refreshToken;
  if (refreshToken) tokens.refreshToken = refreshToken;
  const expiresIn = num(b.expires_in);
  if (expiresIn !== undefined && expiresIn > 0) {
    tokens.expiresAt = new Date(nowOf(ctx).getTime() + expiresIn * 1000).toISOString();
  }
  return tokens;
}

function redactTokenPayload(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) out[k] = /token|secret/i.test(k) ? '[redacted]' : v;
  return out;
}

/**
 * Refresh when the access token expires within `skewSec`. Tokens without expiresAt are
 * treated as non-expiring. Throws PublishError{needsReconnect} when a refresh is impossible.
 */
export async function ensureFreshTokens(
  publisher: Publisher,
  ctx: PublisherContext,
  tokens: TokenSet,
  skewSec = 300,
): Promise<{ tokens: TokenSet; refreshed: boolean }> {
  if (!tokens.expiresAt) return { tokens, refreshed: false };
  const expiresAt = Date.parse(tokens.expiresAt);
  if (!Number.isNaN(expiresAt) && expiresAt - nowOf(ctx).getTime() > skewSec * 1000) {
    return { tokens, refreshed: false };
  }
  const next = await publisher.refresh(ctx, tokens);
  return { tokens: next, refreshed: true };
}

/** Convenience for connect step 1: signed state + PKCE + provider auth URL. */
export function startConnect(
  publisher: Publisher,
  ctx: PublisherContext,
  args: { workspaceId: string; stateSecret: string; ttlSec?: number },
): ConnectStart {
  const state = signState({ workspaceId: args.workspaceId, provider: publisher.provider }, args.stateSecret, {
    ...(args.ttlSec !== undefined ? { ttlSec: args.ttlSec } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
  });
  const pkce = createPkce();
  const authUrl = publisher.getAuthUrl(ctx, { state, codeChallenge: pkce.codeChallenge });
  return { authUrl, state, codeVerifier: pkce.codeVerifier };
}
