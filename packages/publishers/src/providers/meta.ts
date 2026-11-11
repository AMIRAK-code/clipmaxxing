/**
 * Shared Meta (Facebook Login for Business / Graph API) plumbing for the Instagram and Facebook adapters.
 *
 * Docs:
 *  - Manual login flow:  https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
 *  - Long-lived tokens:  https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 *  - Error codes:        https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
import { PublishError } from '../errors';
import { httpRequest, type AssetSource, type ErrorMapper } from '../http';
import { buildAuthUrl, tokenSetFromOAuth } from '../oauth';
import type { PublisherContext, TokenSet } from '../types';
import { asArray, asRecord, bool, num, reportProgress, str, toArrayBuffer } from '../util';

/** Default Graph API version (override with config.extra.graphVersion; Meta's docs currently show v27.0). */
export const DEFAULT_GRAPH_VERSION = 'v23.0';

export function graphVersion(ctx: PublisherContext): string {
  const v = ctx.config.extra?.graphVersion?.trim();
  if (!v) return DEFAULT_GRAPH_VERSION;
  return v.startsWith('v') ? v : `v${v}`;
}

export function graphUrl(ctx: PublisherContext, path: string): string {
  return `https://graph.facebook.com/${graphVersion(ctx)}/${path.replace(/^\//, '')}`;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002, 80004, 80006]);

export const metaError: ErrorMapper = (info) => {
  const err = asRecord(asRecord(info.body).error);
  const code = num(err.code);
  if (code === undefined && !str(err.message)) return undefined;
  const subcode = num(err.error_subcode);
  const message = str(err.error_user_msg) ?? str(err.message) ?? `HTTP ${info.status}`;
  const base = { status: info.status, providerPayload: info.body };
  if (code === 190 || code === 102 || (info.status === 401 && str(err.type) === 'OAuthException')) {
    return new PublishError(`Meta access token is invalid or expired: ${message}`, { ...base, code: 'auth_invalid', needsReconnect: true });
  }
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) {
    return new PublishError(`Missing Meta permission: ${message}`, { ...base, code: 'permission_denied', needsReconnect: true });
  }
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    return new PublishError(`Meta rate limit reached: ${message}`, { ...base, code: 'rate_limited', retryable: true, retryAfterSec: 3600 });
  }
  if (code === 9 && subcode === 2207042) {
    return new PublishError(`Instagram publishing limit reached: ${message}`, { ...base, code: 'quota_exceeded', retryable: true, retryAfterSec: 3600 });
  }
  if (code === 1 || code === 2 || bool(err.is_transient) === true || info.status >= 500) {
    return new PublishError(`Meta temporary error: ${message}`, { ...base, code: 'provider_unavailable', retryable: true });
  }
  return new PublishError(`Meta API error${code !== undefined ? ` (${code}${subcode !== undefined ? `/${subcode}` : ''})` : ''}: ${message}`, {
    ...base,
    code: 'provider_error',
  });
};

export function metaAuthUrl(ctx: PublisherContext, args: { state: string }, scopes: string[]): string {
  return buildAuthUrl(`https://www.facebook.com/${graphVersion(ctx)}/dialog/oauth`, {
    client_id: ctx.config.clientId,
    redirect_uri: ctx.config.redirectUri,
    state: args.state,
    response_type: 'code',
    // Facebook Login for Business uses a configuration id instead of a scope list when provided.
    config_id: ctx.config.extra?.configId,
    scope: ctx.config.extra?.configId ? undefined : scopes.join(','),
  });
}

/** Exchange a short-lived (or still valid long-lived) user token for a fresh ~60 day token. */
export async function exchangeLongLived(ctx: PublisherContext, accessToken: string, scopes: string[]): Promise<TokenSet> {
  const res = await httpRequest(ctx, {
    url: graphUrl(ctx, 'oauth/access_token'),
    form: {
      grant_type: 'fb_exchange_token',
      client_id: ctx.config.clientId,
      client_secret: ctx.config.clientSecret,
      fb_exchange_token: accessToken,
    },
    mapError: metaError,
  });
  return tokenSetFromOAuth(ctx, res.data, { scopes });
}

/** Code -> short-lived token -> long-lived token. */
export async function metaExchangeCode(ctx: PublisherContext, code: string, scopes: string[]): Promise<TokenSet> {
  const res = await httpRequest(ctx, {
    url: graphUrl(ctx, 'oauth/access_token'),
    form: {
      client_id: ctx.config.clientId,
      client_secret: ctx.config.clientSecret,
      redirect_uri: ctx.config.redirectUri,
      code,
    },
    mapError: metaError,
  });
  const short = tokenSetFromOAuth(ctx, res.data, { scopes });
  return exchangeLongLived(ctx, short.accessToken, scopes);
}

export async function metaRefresh(ctx: PublisherContext, tokens: TokenSet): Promise<TokenSet> {
  if (tokens.expiresAt && Date.parse(tokens.expiresAt) <= (ctx.now ? ctx.now() : new Date()).getTime()) {
    throw new PublishError('The Meta access token already expired; reconnect the account.', { code: 'auth_invalid', needsReconnect: true });
  }
  return exchangeLongLived(ctx, tokens.accessToken, tokens.scopes);
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken?: string;
  pictureUrl?: string;
  tasks: string[];
  instagram?: { id: string; username?: string; name?: string; pictureUrl?: string };
}

/** All Pages the user manages, with page tokens and linked Instagram professional accounts. */
export async function fetchMetaPages(ctx: PublisherContext, userToken: string): Promise<MetaPage[]> {
  const pages: MetaPage[] = [];
  let url: string | undefined = graphUrl(ctx, 'me/accounts');
  let query: Record<string, string | number> | undefined = {
    fields: 'id,name,access_token,tasks,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
    limit: 100,
  };
  for (let page = 0; url && page < 10; page++) {
    const res: { data: unknown } = await httpRequest(ctx, { url, ...(query ? { query } : {}), bearer: userToken, mapError: metaError });
    for (const item of asArray(asRecord(res.data).data)) {
      const p = asRecord(item);
      const id = str(p.id);
      if (!id) continue;
      const entry: MetaPage = {
        id,
        name: str(p.name) ?? id,
        tasks: asArray(p.tasks).filter((t): t is string => typeof t === 'string'),
      };
      const token = str(p.access_token);
      if (token) entry.accessToken = token;
      const picture = str(asRecord(asRecord(p.picture).data).url);
      if (picture) entry.pictureUrl = picture;
      const ig = asRecord(p.instagram_business_account);
      const igId = str(ig.id);
      if (igId) {
        entry.instagram = { id: igId };
        const username = str(ig.username);
        if (username) entry.instagram.username = username;
        const name = str(ig.name);
        if (name) entry.instagram.name = name;
        const pic = str(ig.profile_picture_url);
        if (pic) entry.instagram.pictureUrl = pic;
      }
      pages.push(entry);
    }
    url = str(asRecord(asRecord(res.data).paging).next);
    query = undefined; // the `next` URL already carries the query
  }
  return pages;
}

/**
 * Upload the whole file to a rupload.facebook.com session in one request
 * (`Authorization: OAuth`, `offset: 0`, `file_size`). The file is read into memory once;
 * Reels are capped at 300 MB (Instagram) / ~1 GB (Facebook) by validate().
 */
export async function ruploadBinary(ctx: PublisherContext, url: string, token: string, source: AssetSource): Promise<unknown> {
  const bytes = await source.readChunk(0, source.size);
  if (bytes.byteLength !== source.size) {
    throw new PublishError('Could not read the whole render file', { code: 'asset_read_mismatch', retryable: true });
  }
  const res = await httpRequest(ctx, {
    method: 'POST',
    url,
    headers: {
      Authorization: `OAuth ${token}`,
      offset: '0',
      file_size: String(source.size),
      'Content-Type': 'application/octet-stream',
    },
    // Avoid a second full copy when the buffer is already exactly the file.
    body: bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength ? (bytes.buffer as ArrayBuffer) : toArrayBuffer(bytes),
    mapError: metaError,
  });
  reportProgress(ctx, 100);
  return res.data;
}

/** Upload by letting Meta fetch a hosted file (`file_url` header). */
export async function ruploadFromUrl(ctx: PublisherContext, url: string, token: string, fileUrl: string): Promise<unknown> {
  const res = await httpRequest(ctx, {
    method: 'POST',
    url,
    headers: { Authorization: `OAuth ${token}`, file_url: fileUrl },
    mapError: metaError,
  });
  return res.data;
}

/** Parse `/insights`-style `{ data: [{ name, values: [{ value }] }] }` into a name -> value map. */
export function insightsMap(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of asArray(asRecord(body).data)) {
    const row = asRecord(item);
    const name = str(row.name);
    if (!name) continue;
    const first = asRecord(asArray(row.values)[0]);
    out[name] = first.value ?? asRecord(row.total_value).value;
  }
  return out;
}
