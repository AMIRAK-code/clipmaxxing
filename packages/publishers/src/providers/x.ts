/**
 * X adapter (OAuth 2.0 PKCE, v2 chunked media upload, POST /2/tweets).
 *
 * Docs (verified 2026-11):
 *  - OAuth 2.0 PKCE:        https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
 *  - Chunked media upload:  https://docs.x.com/x-api/media/quickstart/media-upload-chunked
 *      POST /2/media/upload/initialize (JSON) -> POST /2/media/upload/{id}/append (multipart)
 *      -> POST /2/media/upload/{id}/finalize -> GET /2/media/upload?command=STATUS&media_id=
 *  - Create post:           https://docs.x.com/x-api/posts/create-post
 *  - Post lookup / metrics: https://docs.x.com/x-api/posts/get-post-by-id
 */
import { z } from 'zod';
import { composeCaption } from '../caption';
import { PublishError } from '../errors';
import { chunkSizeOf, httpRequest, planChunks, pollOptionsOf, pollUntil, uploadInChunks, withAssetSource, type ErrorMapper } from '../http';
import { PLATFORM_LIMITS, X_LONG_VIDEO_MAX_BYTES, X_LONG_VIDEO_MAX_SEC } from '../limits';
import { buildAuthUrl, tokenSetFromOAuth } from '../oauth';
import type { AccountInfo, Publisher, PublisherContext } from '../types';
import { asRecord, compact, metricsOf, num, pick, str } from '../util';
import { issue, parseOptions, validateCommon } from '../validate';

const AUTH_URL = 'https://x.com/i/oauth2/authorize';
const API = 'https://api.x.com/2';
const TOKEN_URL = `${API}/oauth2/token`;

export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];

export const xOptionsSchema = z.object({
  /** The posting account has Premium: allow videos beyond 140 s (uses media_category amplify_video). */
  longVideo: z.boolean().default(false),
  replySettings: z.enum(['following', 'mentionedUsers', 'subscribers', 'verified']).optional(),
});
export type XOptions = z.infer<typeof xOptionsSchema>;

const xError: ErrorMapper = (info) => {
  const body = asRecord(info.body);
  const detail = str(body.detail) ?? str(pick(body, 'errors', 0, 'message')) ?? str(pick(body, 'errors', 0, 'detail')) ?? str(body.title) ?? str(body.error_description) ?? `HTTP ${info.status}`;
  const type = `${str(body.type) ?? ''} ${str(body.reason) ?? ''} ${str(body.title) ?? ''}`.toLowerCase();
  const base = { status: info.status, providerPayload: info.body };
  if (info.status === 429) {
    const reset = num(info.headers.get('x-rate-limit-reset'));
    const retryAfterSec = reset !== undefined ? Math.max(1, Math.ceil(reset - info.now.getTime() / 1000)) : undefined;
    return new PublishError(`X rate limit reached: ${detail}`, {
      ...base,
      code: 'rate_limited',
      retryable: true,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    });
  }
  if (info.status === 401 || str(body.error) === 'invalid_grant' || str(body.error) === 'invalid_request' && /token/i.test(detail)) {
    return new PublishError(`X authorization failed: ${detail}`, { ...base, code: 'auth_invalid', needsReconnect: true });
  }
  if (info.status === 402) {
    return new PublishError(`X API credits/tier required: ${detail}`, { ...base, code: 'tier_required' });
  }
  if (info.status === 403) {
    if (/duplicate/i.test(detail)) return new PublishError(`X rejected duplicate content: ${detail}`, { ...base, code: 'duplicate_content' });
    if (/video longer than/i.test(detail)) return new PublishError(`X: ${detail}`, { ...base, code: 'duration_too_long' });
    if (/suspended|locked/i.test(detail)) return new PublishError(`X account restricted: ${detail}`, { ...base, code: 'account_restricted', needsReconnect: true });
    // Only access-level / tier / product restrictions are "tier_required" (client-not-enrolled, usage cap for the tier, ...).
    // X error docs checked 2026-11-11: https://docs.x.com/x-api/fundamentals/response-codes-and-errors
    const typeText = `${type} ${str(body.type) ?? ''}`;
    const tierRestricted =
      /client-not-enrolled|not-enrolled|client-forbidden|usage-capped|unsupported-authentication/.test(typeText) ||
      /access level|not enrolled|enrolled in|usage cap|cap exceeded|api product|your tier|upgrade|subscription|credits/i.test(detail);
    if (tierRestricted) {
      return new PublishError(`X API tier/access level does not allow this request: ${detail}`, { ...base, code: 'tier_required' });
    }
    return new PublishError(`X refused the request: ${detail}`, { ...base, code: 'forbidden' });
  }
  return undefined;
};

function basicAuth(ctx: PublisherContext): string {
  return `Basic ${Buffer.from(`${ctx.config.clientId}:${ctx.config.clientSecret}`, 'utf8').toString('base64')}`;
}

function tweetUrl(account: AccountInfo, id: string): string {
  return account.username ? `https://x.com/${account.username.replace(/^@/, '')}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

export const xPublisher: Publisher = {
  provider: 'x',
  limits: PLATFORM_LIMITS.x,

  getAuthUrl(ctx, args) {
    if (!args.codeChallenge) {
      throw new PublishError('X OAuth 2.0 requires PKCE: pass codeChallenge', { code: 'pkce_required' });
    }
    return buildAuthUrl(AUTH_URL, {
      response_type: 'code',
      client_id: ctx.config.clientId,
      redirect_uri: ctx.config.redirectUri,
      scope: X_SCOPES.join(' '),
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
    });
  },

  async connect(ctx, args) {
    if (!args.codeVerifier) throw new PublishError('X OAuth 2.0 requires the PKCE codeVerifier', { code: 'pkce_required' });
    const res = await httpRequest(ctx, {
      url: TOKEN_URL,
      headers: { Authorization: basicAuth(ctx) },
      form: {
        grant_type: 'authorization_code',
        code: args.code,
        redirect_uri: ctx.config.redirectUri,
        code_verifier: args.codeVerifier,
        client_id: ctx.config.clientId,
      },
      mapError: xError,
    });
    const tokens = tokenSetFromOAuth(ctx, res.data, { scopes: X_SCOPES });
    const me = await httpRequest(ctx, {
      url: `${API}/users/me`,
      query: { 'user.fields': 'profile_image_url,username,name' },
      bearer: tokens.accessToken,
      mapError: xError,
    });
    const user = asRecord(asRecord(me.data).data);
    const id = str(user.id);
    if (!id) throw new PublishError('X did not return the user profile', { code: 'provider_error', providerPayload: me.data });
    const account: AccountInfo = { externalAccountId: id, displayName: str(user.name) ?? str(user.username) ?? id, meta: { userId: id } };
    const username = str(user.username);
    if (username) account.username = username;
    const avatar = str(user.profile_image_url);
    if (avatar) account.avatarUrl = avatar;
    return { tokens, accounts: [account] };
  },

  /** X rotates refresh tokens: always persist the returned TokenSet. */
  async refresh(ctx, tokens) {
    if (!tokens.refreshToken) {
      throw new PublishError('No X refresh token stored (offline.access missing); reconnect the account.', { code: 'auth_invalid', needsReconnect: true });
    }
    const res = await httpRequest(ctx, {
      url: TOKEN_URL,
      headers: { Authorization: basicAuth(ctx) },
      form: { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: ctx.config.clientId },
      mapError: (info) => {
        if (info.status === 400) {
          return new PublishError('X refresh token is invalid or already used; reconnect the account.', {
            code: 'auth_invalid',
            needsReconnect: true,
            status: 400,
            providerPayload: info.body,
          });
        }
        return xError(info);
      },
    });
    return tokenSetFromOAuth(ctx, res.data, { refreshToken: tokens.refreshToken, scopes: tokens.scopes });
  },

  validate(render, meta) {
    const parsed = parseOptions(xOptionsSchema, meta.options);
    const long = parsed.data?.longVideo === true;
    const issues = validateCommon('x', render, meta, long ? { maxDurationSec: X_LONG_VIDEO_MAX_SEC, maxSizeBytes: X_LONG_VIDEO_MAX_BYTES } : {});
    issues.push(...parsed.issues);
    if (long && render.durationSec > PLATFORM_LIMITS.x.maxDurationSec) {
      issues.push(issue('render.durationSec', 'premium_required', 'Videos longer than 140s only post from X Premium accounts.', 'warning'));
    }
    return issues;
  },

  async publish(ctx, { tokens, account, render, meta }) {
    const parsed = parseOptions(xOptionsSchema, meta.options);
    if (!parsed.data) throw new PublishError(`Invalid X options: ${parsed.issues.map((i) => i.message).join('; ')}`, { code: 'invalid_options' });
    const options = parsed.data;
    const token = tokens.accessToken;
    const category = options.longVideo && render.durationSec > PLATFORM_LIMITS.x.maxDurationSec ? 'amplify_video' : 'tweet_video';

    const { mediaId, finalize } = await withAssetSource(render, ctx, async (source) => {
      const init = await httpRequest(ctx, {
        url: `${API}/media/upload/initialize`,
        bearer: token,
        json: { media_type: 'video/mp4', total_bytes: source.size, media_category: category },
        mapError: xError,
      });
      const id = str(pick(init.data, 'data', 'id'));
      if (!id) throw new PublishError('X media initialize returned no id', { code: 'provider_error', providerPayload: init.data });
      // Segments should stay <= 5 MB.
      const ranges = planChunks(source.size, Math.min(chunkSizeOf(ctx, 4 * 1024 * 1024), 5 * 1024 * 1024));
      await uploadInChunks(ctx, source, ranges, async (chunk) => {
        const form = new FormData();
        form.set('segment_index', String(chunk.index));
        form.set('media', new Blob([chunk.data], { type: 'application/octet-stream' }), 'chunk.mp4');
        await httpRequest(ctx, { method: 'POST', url: `${API}/media/upload/${id}/append`, bearer: token, body: form, mapError: xError });
      });
      const fin = await httpRequest(ctx, { method: 'POST', url: `${API}/media/upload/${id}/finalize`, bearer: token, mapError: xError });
      return { mediaId: id, finalize: fin.data };
    });

    let processing = asRecord(pick(finalize, 'data', 'processing_info'));
    if (str(processing.state) && str(processing.state) !== 'succeeded') {
      const opts = pollOptionsOf(ctx, { maxAttempts: 40, intervalMs: 3000 });
      const firstWait = (num(processing.check_after_secs) ?? opts.intervalMs / 1000) * 1000;
      if (str(processing.state) !== 'failed') await (ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(firstWait);
      const polled = await pollUntil(
        ctx,
        async () => {
          if (str(processing.state) === 'failed') return { done: true, value: processing };
          const res = await httpRequest(ctx, {
            url: `${API}/media/upload`,
            query: { command: 'STATUS', media_id: mediaId },
            bearer: token,
            mapError: xError,
          });
          processing = asRecord(pick(res.data, 'data', 'processing_info'));
          const state = str(processing.state);
          const wait = num(processing.check_after_secs);
          return { done: state === 'succeeded' || state === 'failed' || !state, value: processing, ...(wait !== undefined ? { waitMs: wait * 1000 } : {}) };
        },
        opts,
      );
      if (str(polled.value.state) === 'failed') {
        throw new PublishError(`X could not process the video: ${str(pick(polled.value, 'error', 'message')) ?? 'unknown error'}`, {
          code: 'processing_failed',
          providerPayload: polled.value,
        });
      }
      if (!polled.done) {
        // The post cannot be created before the media is ready, so there is no id to hand back yet.
        throw new PublishError('X is still processing the video; retry the publish later.', { code: 'media_processing_timeout', retryable: true, retryAfterSec: 60 });
      }
    }

    const tweet = await httpRequest(ctx, {
      url: `${API}/tweets`,
      bearer: token,
      json: compact({ text: composeCaption('x', meta), media: { media_ids: [mediaId] }, reply_settings: options.replySettings }),
      mapError: xError,
    });
    const id = str(pick(tweet.data, 'data', 'id'));
    if (!id) throw new PublishError('X did not return a post id', { code: 'provider_error', providerPayload: tweet.data });
    return { externalId: id, status: 'published', url: tweetUrl(account, id) };
  },

  async getStatus(ctx, { tokens, account, externalId }) {
    try {
      const res = await httpRequest(ctx, { url: `${API}/tweets/${externalId}`, bearer: tokens.accessToken, mapError: xError });
      if (!str(pick(res.data, 'data', 'id'))) {
        return { status: 'failed', error: str(pick(res.data, 'errors', 0, 'detail')) ?? 'Post not found (deleted?).' };
      }
      return { status: 'published', url: tweetUrl(account, externalId) };
    } catch (err) {
      if (err instanceof PublishError && err.status === 404) return { status: 'failed', error: 'Post not found (deleted?).' };
      throw err;
    }
  },

  async fetchMetrics(ctx, { tokens, externalId }) {
    const res = await httpRequest(ctx, {
      url: `${API}/tweets/${externalId}`,
      query: {
        'tweet.fields': 'public_metrics,organic_metrics',
        expansions: 'attachments.media_keys',
        'media.fields': 'public_metrics,duration_ms',
      },
      bearer: tokens.accessToken,
      mapError: xError,
    });
    const pub = asRecord(pick(res.data, 'data', 'public_metrics'));
    const org = asRecord(pick(res.data, 'data', 'organic_metrics'));
    const media = asRecord(pick(res.data, 'includes', 'media', 0, 'public_metrics'));
    const retweets = num(pub.retweet_count);
    const quotes = num(pub.quote_count);
    return metricsOf({
      views: num(media.view_count),
      impressions: num(pub.impression_count) ?? num(org.impression_count),
      likes: num(pub.like_count) ?? num(org.like_count),
      comments: num(pub.reply_count) ?? num(org.reply_count),
      shares: retweets !== undefined || quotes !== undefined ? (retweets ?? 0) + (quotes ?? 0) : undefined,
      saves: num(pub.bookmark_count),
      raw: res.data,
    });
  },
};
