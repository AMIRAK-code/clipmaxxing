/**
 * YouTube adapter (Data API v3, resumable videos.insert).
 *
 * Docs:
 *  - OAuth web server flow: https://developers.google.com/identity/protocols/oauth2/web-server
 *  - Resumable upload:      https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 *  - videos.insert:         https://developers.google.com/youtube/v3/docs/videos/insert
 *  - videos.list:           https://developers.google.com/youtube/v3/docs/videos/list
 *  - Error reasons:         https://developers.google.com/youtube/v3/docs/errors
 */
import { z } from 'zod';
import { backoffDelayMs } from '../backoff';
import { composeCaption, composeTitle, normalizeHashtag } from '../caption';
import { PublishError } from '../errors';
import { chunkSizeOf, httpRequest, withAssetSource, type AssetSource, type ErrorMapper } from '../http';
import { PLATFORM_LIMITS } from '../limits';
import { buildAuthUrl, tokenSetFromOAuth } from '../oauth';
import type { AccountInfo, Publisher, PublisherContext, TokenSet } from '../types';
import { asArray, asRecord, compact, extraNum, metricsOf, num, pick, reportProgress, sleepOf, str, toArrayBuffer } from '../util';
import { parseOptions, validateCommon } from '../validate';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

export const youtubeOptionsSchema = z.object({
  privacyStatus: z.enum(['public', 'unlisted', 'private']).default('public'),
  madeForKids: z.boolean().default(false),
  categoryId: z.string().regex(/^\d+$/, 'categoryId must be numeric').default('22'),
  notifySubscribers: z.boolean().default(true),
  containsSyntheticMedia: z.boolean().optional(),
  /** Also append " #Shorts" to the title (the description always carries it). */
  appendShortsToTitle: z.boolean().default(false),
});
export type YouTubeOptions = z.infer<typeof youtubeOptionsSchema>;

/** Seconds until the next midnight in America/Los_Angeles (when the YouTube API quota resets). */
export function secondsUntilPacificMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0) || 0;
  const elapsed = (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
  return Math.max(1, 86400 - elapsed);
}

const youtubeError: ErrorMapper = (info) => {
  const err = asRecord(asRecord(info.body).error);
  const reason = str(pick(err, 'errors', 0, 'reason')) ?? '';
  const message = str(err.message) ?? `HTTP ${info.status}`;
  const base = { status: info.status, providerPayload: info.body };
  if (info.status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
    return new PublishError(`YouTube API quota exhausted: ${message}`, {
      ...base,
      code: 'quota_exceeded',
      retryable: true,
      retryAfterSec: secondsUntilPacificMidnight(info.now),
    });
  }
  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
    return new PublishError(`YouTube rate limit: ${message}`, { ...base, code: 'rate_limited', retryable: true, retryAfterSec: 60 });
  }
  if (reason === 'uploadLimitExceeded') {
    return new PublishError(`YouTube channel upload limit reached: ${message}`, {
      ...base,
      code: 'upload_limit_exceeded',
      retryable: true,
      retryAfterSec: 24 * 3600,
    });
  }
  if (reason === 'youtubeSignupRequired') {
    return new PublishError('The Google account has no YouTube channel.', { ...base, code: 'channel_required', needsReconnect: true });
  }
  if (info.status === 401 || reason === 'authError' || reason === 'insufficientPermissions') {
    return new PublishError(`YouTube authorization failed: ${message}`, { ...base, code: 'auth_invalid', needsReconnect: true });
  }
  return undefined;
};

/** Google token endpoint: invalid_grant = refresh token revoked/expired. */
const googleTokenError: ErrorMapper = (info) => {
  const code = str(asRecord(info.body).error);
  if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') {
    return new PublishError(`Google rejected the credentials (${code})`, {
      code: 'auth_invalid',
      needsReconnect: true,
      status: info.status,
      providerPayload: info.body,
    });
  }
  return undefined;
};

function nextOffsetFromRange(range: string | null): number {
  const m = range ? /bytes=0-(\d+)/.exec(range) : null;
  return m?.[1] !== undefined ? Number(m[1]) + 1 : 0;
}

async function uploadResumable(ctx: PublisherContext, uploadUrl: string, source: AssetSource): Promise<unknown> {
  const total = source.size;
  // YouTube requires chunk sizes in multiples of 256 KiB (except the last chunk).
  const align = 256 * 1024;
  const requested = chunkSizeOf(ctx, 8 * 1024 * 1024);
  // Real uploads must use multiples of 256 KiB; sub-256 KiB values are only meaningful for tests.
  const chunkSize = requested < align ? requested : Math.floor(requested / align) * align;
  const maxRetries = Math.floor(extraNum(ctx, 'uploadMaxRetries', 5));
  const sleep = sleepOf(ctx);
  let offset = 0;
  let failures = 0;

  for (;;) {
    const end = Math.min(offset + chunkSize, total);
    try {
      const bytes = await source.readChunk(offset, end);
      const res = await httpRequest(ctx, {
        method: 'PUT',
        url: uploadUrl,
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        body: toArrayBuffer(bytes),
        okStatuses: [308],
        mapError: youtubeError,
      });
      if (res.status !== 308) {
        reportProgress(ctx, 100);
        return res.data;
      }
      failures = 0;
      offset = res.headers.get('range') ? nextOffsetFromRange(res.headers.get('range')) : end;
      reportProgress(ctx, (offset / total) * 100);
      continue;
    } catch (err) {
      const transient = err instanceof PublishError && err.retryable && (err.code === 'network_error' || (err.status ?? 0) >= 500);
      if (!transient || failures >= maxRetries) throw err;
      failures++;
      await sleep(backoffDelayMs(failures));
    }
    // Ask the server how much it has, then resume from there.
    try {
      const probe = await httpRequest(ctx, {
        method: 'PUT',
        url: uploadUrl,
        headers: { 'Content-Range': `bytes */${total}` },
        okStatuses: [308],
        mapError: youtubeError,
      });
      if (probe.status !== 308) return probe.data;
      offset = nextOffsetFromRange(probe.headers.get('range'));
    } catch (err) {
      const transient = err instanceof PublishError && err.retryable && (err.code === 'network_error' || (err.status ?? 0) >= 500);
      if (!transient) throw err;
      /* keep the previous offset and try again on the next loop */
    }
  }
}

export const youtubePublisher: Publisher = {
  provider: 'youtube',
  limits: PLATFORM_LIMITS.youtube,

  getAuthUrl(ctx, args) {
    return buildAuthUrl(AUTH_URL, {
      client_id: ctx.config.clientId,
      redirect_uri: ctx.config.redirectUri,
      response_type: 'code',
      scope: YOUTUBE_SCOPES.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: args.codeChallenge ? 'S256' : undefined,
    });
  },

  async connect(ctx, args) {
    const res = await httpRequest(ctx, {
      url: TOKEN_URL,
      form: {
        grant_type: 'authorization_code',
        code: args.code,
        client_id: ctx.config.clientId,
        client_secret: ctx.config.clientSecret,
        redirect_uri: ctx.config.redirectUri,
        code_verifier: args.codeVerifier,
      },
      mapError: googleTokenError,
    });
    const tokens = tokenSetFromOAuth(ctx, res.data, { scopes: YOUTUBE_SCOPES });
    const channels = await httpRequest(ctx, {
      url: `${API}/channels`,
      query: { part: 'snippet', mine: true },
      bearer: tokens.accessToken,
      mapError: youtubeError,
    });
    const accounts: AccountInfo[] = [];
    for (const item of asArray(asRecord(channels.data).items)) {
      const id = str(pick(item, 'id'));
      if (!id) continue;
      const account: AccountInfo = {
        externalAccountId: id,
        displayName: str(pick(item, 'snippet', 'title')) ?? id,
        meta: { channelId: id },
      };
      const username = str(pick(item, 'snippet', 'customUrl'));
      if (username) account.username = username;
      const avatar = str(pick(item, 'snippet', 'thumbnails', 'default', 'url'));
      if (avatar) account.avatarUrl = avatar;
      accounts.push(account);
    }
    if (accounts.length === 0) {
      throw new PublishError('The Google account has no YouTube channel.', { code: 'channel_required', needsReconnect: true });
    }
    return { tokens, accounts };
  },

  async refresh(ctx, tokens) {
    if (!tokens.refreshToken) {
      throw new PublishError('No YouTube refresh token stored; reconnect the account.', { code: 'auth_invalid', needsReconnect: true });
    }
    const res = await httpRequest(ctx, {
      url: TOKEN_URL,
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: ctx.config.clientId,
        client_secret: ctx.config.clientSecret,
      },
      mapError: googleTokenError,
    });
    return tokenSetFromOAuth(ctx, res.data, { refreshToken: tokens.refreshToken, scopes: tokens.scopes });
  },

  validate(render, meta) {
    const issues = validateCommon('youtube', render, meta, { videoCodecs: ['h264', 'hevc', 'vp9', 'av1'] });
    issues.push(...parseOptions(youtubeOptionsSchema, meta.options).issues);
    if (meta.title !== undefined && /[<>]/.test(meta.title)) {
      issues.push({ field: 'title', code: 'title_invalid_chars', message: 'YouTube titles cannot contain < or >.', severity: 'warning' });
    }
    return issues;
  },

  async publish(ctx, { tokens, render, meta }) {
    const parsed = parseOptions(youtubeOptionsSchema, meta.options);
    if (!parsed.data) {
      throw new PublishError(`Invalid YouTube options: ${parsed.issues.map((i) => i.message).join('; ')}`, { code: 'invalid_options' });
    }
    const options = parsed.data;
    const tags = meta.hashtags.map((h) => normalizeHashtag(h)).filter((t): t is string => !!t).slice(0, 30);
    const body = {
      snippet: compact({
        title: composeTitle('youtube', meta, { appendShorts: options.appendShortsToTitle }),
        description: composeCaption('youtube', meta),
        categoryId: options.categoryId,
        tags: tags.length > 0 ? tags : undefined,
      }),
      status: compact({
        privacyStatus: options.privacyStatus,
        selfDeclaredMadeForKids: options.madeForKids,
        containsSyntheticMedia: options.containsSyntheticMedia,
      }),
    };

    const video = await withAssetSource(render, ctx, async (source) => {
      const init = await httpRequest(ctx, {
        method: 'POST',
        url: UPLOAD_URL,
        query: { uploadType: 'resumable', part: 'snippet,status', notifySubscribers: options.notifySubscribers },
        bearer: tokens.accessToken,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(source.size),
          'X-Upload-Content-Type': 'video/mp4',
        },
        json: body,
        mapError: youtubeError,
      });
      const location = init.headers.get('location');
      if (!location) {
        throw new PublishError('YouTube did not return a resumable upload URL', { code: 'provider_error', retryable: true });
      }
      return uploadResumable(ctx, location, source);
    });

    const id = str(asRecord(video).id);
    if (!id) throw new PublishError('YouTube upload finished without a video id', { code: 'provider_error', providerPayload: video });
    // The video still has to be processed; getStatus() reports when it is live.
    return { externalId: id, status: 'processing', url: `https://www.youtube.com/shorts/${id}` };
  },

  async getStatus(ctx, { tokens, externalId }) {
    const res = await httpRequest(ctx, {
      url: `${API}/videos`,
      query: { part: 'status,processingDetails', id: externalId },
      bearer: tokens.accessToken,
      mapError: youtubeError,
    });
    const item = asArray(asRecord(res.data).items)[0];
    if (!item) return { status: 'failed', error: 'Video not found (deleted or removed).' };
    const url = `https://www.youtube.com/shorts/${externalId}`;
    const uploadStatus = str(pick(item, 'status', 'uploadStatus'));
    switch (uploadStatus) {
      case 'processed':
        return { status: 'published', url };
      case 'failed':
        return { status: 'failed', error: `Processing failed: ${str(pick(item, 'status', 'failureReason')) ?? 'unknown'}` };
      case 'rejected':
        return { status: 'failed', error: `Rejected: ${str(pick(item, 'status', 'rejectionReason')) ?? 'unknown'}` };
      case 'deleted':
        return { status: 'failed', error: 'Video was deleted.' };
      default:
        return { status: 'processing', url };
    }
  },

  async fetchMetrics(ctx, { tokens, externalId }) {
    const res = await httpRequest(ctx, {
      url: `${API}/videos`,
      query: { part: 'statistics', id: externalId },
      bearer: tokens.accessToken,
      mapError: youtubeError,
    });
    const stats = asRecord(pick(res.data, 'items', 0, 'statistics'));
    return metricsOf({
      views: num(stats.viewCount),
      likes: num(stats.likeCount),
      comments: num(stats.commentCount),
      raw: res.data,
    });
  },
};
