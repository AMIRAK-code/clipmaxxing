/**
 * TikTok adapter (Login Kit OAuth v2 + Content Posting API, Direct Post).
 *
 * Docs:
 *  - OAuth:          https://developers.tiktok.com/doc/oauth-user-access-token-management
 *  - Creator info:   https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
 *  - Direct post:    https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *  - Media transfer: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *  - Status:         https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 *  - UX guidelines:  https://developers.tiktok.com/doc/content-sharing-guidelines
 *  - Video query:    https://developers.tiktok.com/doc/tiktok-api-v2-video-query
 *
 * Default source is FILE_UPLOAD (chunked binary upload from the local render). PULL_FROM_URL is
 * used only when render.url is set and config.extra.tiktokSource === 'pull' (needs a verified domain).
 */
import { z } from 'zod';
import { composeCaption } from '../caption';
import { PublishError } from '../errors';
import {
  httpRequest,
  pollOptionsOf,
  pollUntil,
  uploadInChunks,
  withAssetSource,
  type ByteRange,
  type ErrorMapper,
  type HttpRequestOptions,
} from '../http';
import { PLATFORM_LIMITS } from '../limits';
import { buildAuthUrl, parseScopes, tokenSetFromOAuth } from '../oauth';
import type { AccountInfo, PostStatus, Publisher, PublisherContext, TokenSet } from '../types';
import { asArray, asRecord, bool, compact, extraNum, metricsOf, num, pick, str } from '../util';
import { issue, parseOptions, validateCommon } from '../validate';

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com';
const TOKEN_URL = `${API}/v2/oauth/token/`;

export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.list'];

export const TIKTOK_PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

/* Consent / disclosure copy required by TikTok's Content Sharing Guidelines (shown next to the Post button). */
export const TIKTOK_MUSIC_USAGE_URL = 'https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';
export const TIKTOK_BRANDED_CONTENT_POLICY_URL = 'https://www.tiktok.com/legal/page/global/bc-policy/en';
export const TIKTOK_CONSENT_TEXT = "By posting, you agree to TikTok's Music Usage Confirmation";
export const TIKTOK_CONSENT_TEXT_BRANDED = "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation";
export const TIKTOK_LABEL_PROMOTIONAL = "Your video will be labeled as 'Promotional content'";
export const TIKTOK_LABEL_PAID_PARTNERSHIP = "Your video will be labeled as 'Paid partnership'";
export const TIKTOK_BRANDED_PRIVACY_NOTICE = 'Branded content visibility cannot be set to private';
export const TIKTOK_DISCLOSURE_PROMPT = 'You need to indicate if your content promotes yourself, a third party, or both';

/** Consent line to display for the current commercial-content selection. */
export function getTikTokConsentText(opts: { brandContentToggle?: boolean; brandOrganicToggle?: boolean }): string {
  return opts.brandContentToggle ? TIKTOK_CONSENT_TEXT_BRANDED : TIKTOK_CONSENT_TEXT;
}

/** Label notice to display for the current commercial-content selection (undefined when none). */
export function getTikTokDisclosureLabel(opts: { brandContentToggle?: boolean; brandOrganicToggle?: boolean }): string | undefined {
  if (opts.brandContentToggle) return TIKTOK_LABEL_PAID_PARTNERSHIP;
  if (opts.brandOrganicToggle) return TIKTOK_LABEL_PROMOTIONAL;
  return undefined;
}

export const tiktokOptionsSchema = z.object({
  /** No default on purpose: the user must pick one in the UI (audit requirement). */
  privacyLevel: z.enum(TIKTOK_PRIVACY_LEVELS).optional(),
  disableComment: z.boolean().default(false),
  disableDuet: z.boolean().default(false),
  disableStitch: z.boolean().default(false),
  /** "Disclose video content" switch. When on, at least one of the two toggles below must be on. */
  discloseCommercialContent: z.boolean().default(false),
  /** Paid partnership / third-party brand. */
  brandContentToggle: z.boolean().default(false),
  /** Promoting the creator's own business ("Your brand"). */
  brandOrganicToggle: z.boolean().default(false),
  /** The user explicitly agreed to the consent text shown next to the Post button. */
  consentAccepted: z.boolean().default(false),
  isAigc: z.boolean().optional(),
});
export type TikTokOptions = z.infer<typeof tiktokOptionsSchema>;

export interface TikTokCreatorInfo {
  creatorAvatarUrl?: string;
  creatorUsername?: string;
  creatorNickname?: string;
  privacyLevelOptions: TikTokPrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

const tiktokError: ErrorMapper = (info) => {
  const code = str(pick(info.body, 'error', 'code')) ?? (typeof asRecord(info.body).error === 'string' ? str(asRecord(info.body).error) : undefined);
  const message = str(pick(info.body, 'error', 'message')) ?? str(asRecord(info.body).error_description) ?? `HTTP ${info.status}`;
  return code ? mapTikTokCode(code, message, info.status, info.body) : undefined;
};

function mapTikTokCode(code: string, message: string, status: number, payload: unknown): PublishError | undefined {
  const base = { status, providerPayload: payload };
  switch (code) {
    case 'access_token_invalid':
    case 'scope_not_authorized':
    case 'invalid_grant':
    case 'invalid_client':
    case 'token_not_authorized_for_specified_publish_id':
      return new PublishError(`TikTok authorization failed (${code}): ${message}`, { ...base, code: 'auth_invalid', needsReconnect: true });
    case 'rate_limit_exceeded':
      return new PublishError(`TikTok rate limit: ${message}`, { ...base, code: 'rate_limited', retryable: true, retryAfterSec: 60 });
    case 'spam_risk_too_many_posts':
    case 'reached_active_user_cap':
      return new PublishError(`TikTok daily posting cap reached (${code}): ${message}`, {
        ...base,
        code: 'post_limit_reached',
        retryable: true,
        retryAfterSec: 24 * 3600,
      });
    case 'spam_risk_too_many_pending_share':
      return new PublishError(`TikTok has too many pending posts for this user: ${message}`, {
        ...base,
        code: 'post_limit_reached',
        retryable: true,
        retryAfterSec: 3600,
      });
    case 'spam_risk_user_banned_from_posting':
      return new PublishError(`TikTok banned this user from posting: ${message}`, { ...base, code: 'user_banned' });
    case 'unaudited_client_can_only_post_to_private_accounts':
      return new PublishError(
        'This TikTok app is unaudited: it can only post SELF_ONLY videos, and the TikTok account must be set to private.',
        { ...base, code: 'unaudited_client' },
      );
    case 'url_ownership_unverified':
      return new PublishError('PULL_FROM_URL needs a verified domain/URL prefix in the TikTok developer portal.', {
        ...base,
        code: 'url_ownership_unverified',
      });
    case 'privacy_level_option_mismatch':
      return new PublishError(`TikTok rejected the privacy level: ${message}`, { ...base, code: 'privacy_level_option_mismatch' });
    case 'internal_error':
      return new PublishError(`TikTok internal error: ${message}`, { ...base, code: 'provider_unavailable', retryable: true });
    default:
      return status >= 200 && status < 300
        ? new PublishError(`TikTok error (${code}): ${message}`, { ...base, code: code || 'provider_error' })
        : undefined;
  }
}

/** TikTok wraps everything in `{ data, error: { code: 'ok' | ..., message, log_id } }`, sometimes with HTTP 200 on failure. */
async function tiktokCall(ctx: PublisherContext, req: HttpRequestOptions): Promise<Record<string, unknown>> {
  const res = await httpRequest(ctx, { ...req, mapError: tiktokError });
  const code = str(pick(res.data, 'error', 'code'));
  if (code && code !== 'ok') {
    const message = str(pick(res.data, 'error', 'message')) ?? code;
    throw mapTikTokCode(code, message, res.status, res.data) ?? new PublishError(`TikTok error (${code}): ${message}`, { code, status: res.status, providerPayload: res.data });
  }
  return asRecord(asRecord(res.data).data);
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' };

/** Query what the creator may do right now. The UI must render its privacy picker and interaction toggles from this. */
export async function getTikTokCreatorInfo(ctx: PublisherContext, tokens: TokenSet): Promise<TikTokCreatorInfo> {
  const data = await tiktokCall(ctx, {
    method: 'POST',
    url: `${API}/v2/post/publish/creator_info/query/`,
    bearer: tokens.accessToken,
    headers: JSON_HEADERS,
  });
  return parseCreatorInfo(data);
}

function parseCreatorInfo(data: unknown): TikTokCreatorInfo {
  const d = asRecord(data);
  const levels = asArray(d.privacy_level_options).filter((l): l is TikTokPrivacyLevel =>
    (TIKTOK_PRIVACY_LEVELS as readonly unknown[]).includes(l),
  );
  const info: TikTokCreatorInfo = {
    privacyLevelOptions: levels,
    commentDisabled: bool(d.comment_disabled) ?? false,
    duetDisabled: bool(d.duet_disabled) ?? false,
    stitchDisabled: bool(d.stitch_disabled) ?? false,
    maxVideoPostDurationSec: num(d.max_video_post_duration_sec) ?? PLATFORM_LIMITS.tiktok.maxDurationSec,
  };
  const avatar = str(d.creator_avatar_url);
  if (avatar) info.creatorAvatarUrl = avatar;
  const username = str(d.creator_username);
  if (username) info.creatorUsername = username;
  const nickname = str(d.creator_nickname);
  if (nickname) info.creatorNickname = nickname;
  return info;
}

/** Read a TikTokCreatorInfo previously stored on account.meta.creatorInfo (camelCase or raw API shape). */
function creatorInfoFromAccount(account?: AccountInfo): TikTokCreatorInfo | undefined {
  const raw = account?.meta.creatorInfo;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = asRecord(raw);
  if (Array.isArray(r.privacyLevelOptions)) {
    return parseCreatorInfo({
      privacy_level_options: r.privacyLevelOptions,
      comment_disabled: r.commentDisabled,
      duet_disabled: r.duetDisabled,
      stitch_disabled: r.stitchDisabled,
      max_video_post_duration_sec: r.maxVideoPostDurationSec,
    });
  }
  return parseCreatorInfo(r);
}

const MIN_CHUNK = 5 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;

/**
 * TikTok FILE_UPLOAD chunk plan: chunks of 5-64 MB, total_chunk_count = floor(size / chunk_size),
 * the final chunk absorbs the remainder (up to 128 MB); files under 5 MB go up whole.
 */
export function planTikTokChunks(videoSize: number, preferredChunkSize = 10 * 1024 * 1024): { chunkSize: number; totalChunkCount: number; ranges: ByteRange[] } {
  const preferred = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, Math.floor(preferredChunkSize)));
  if (videoSize <= preferred) {
    return { chunkSize: videoSize, totalChunkCount: 1, ranges: [{ index: 0, start: 0, end: videoSize - 1 }] };
  }
  const totalChunkCount = Math.floor(videoSize / preferred);
  const ranges: ByteRange[] = [];
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * preferred;
    ranges.push({ index: i, start, end: i === totalChunkCount - 1 ? videoSize - 1 : start + preferred - 1 });
  }
  return { chunkSize: preferred, totalChunkCount, ranges };
}

function isNumericId(id: string): boolean {
  return /^\d+$/.test(id);
}

async function fetchPublishStatus(ctx: PublisherContext, tokens: TokenSet, publishId: string): Promise<{ status: PostStatus; postId?: string; raw: unknown }> {
  const data = await tiktokCall(ctx, {
    method: 'POST',
    url: `${API}/v2/post/publish/status/fetch/`,
    bearer: tokens.accessToken,
    headers: JSON_HEADERS,
    json: { publish_id: publishId },
  });
  const state = str(data.status);
  // (sic) the API field really is spelled "publicaly_available_post_id".
  const ids = asArray(data.publicaly_available_post_id ?? data.publicly_available_post_id);
  const postId = str(ids[0]);
  if (state === 'PUBLISH_COMPLETE') {
    return { status: { status: 'published' }, raw: data, ...(postId ? { postId } : {}) };
  }
  if (state === 'FAILED') {
    return { status: { status: 'failed', error: `TikTok publish failed: ${str(data.fail_reason) ?? 'unknown'}` }, raw: data };
  }
  return { status: { status: 'processing' }, raw: data };
}

function postUrl(account: AccountInfo, postId: string | undefined): string | undefined {
  const username = account.username ?? str(account.meta.username);
  return postId && username ? `https://www.tiktok.com/@${username.replace(/^@/, '')}/video/${postId}` : undefined;
}

export const tiktokPublisher: Publisher = {
  provider: 'tiktok',
  limits: PLATFORM_LIMITS.tiktok,

  getAuthUrl(ctx, args) {
    return buildAuthUrl(AUTH_URL, {
      client_key: ctx.config.clientId,
      scope: TIKTOK_SCOPES.join(','),
      response_type: 'code',
      redirect_uri: ctx.config.redirectUri,
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: args.codeChallenge ? 'S256' : undefined,
    });
  },

  async connect(ctx, args) {
    const res = await httpRequest(ctx, {
      url: TOKEN_URL,
      form: {
        client_key: ctx.config.clientId,
        client_secret: ctx.config.clientSecret,
        code: args.code,
        grant_type: 'authorization_code',
        redirect_uri: ctx.config.redirectUri,
        code_verifier: args.codeVerifier,
      },
      mapError: tiktokError,
    });
    const body = asRecord(res.data);
    if (!str(body.access_token) && str(body.error)) {
      throw new PublishError(`TikTok token exchange failed: ${str(body.error_description) ?? str(body.error)}`, {
        code: 'auth_invalid',
        needsReconnect: true,
        providerPayload: { error: body.error, error_description: body.error_description },
      });
    }
    const tokens = tokenSetFromOAuth(ctx, body, { scopes: TIKTOK_SCOPES });
    const openId = str(body.open_id);

    const user = asRecord(
      (
        await tiktokCall(ctx, {
          url: `${API}/v2/user/info/`,
          query: { fields: 'open_id,union_id,avatar_url,display_name' },
          bearer: tokens.accessToken,
        })
      ).user,
    );
    const id = str(user.open_id) ?? openId;
    if (!id) throw new PublishError('TikTok did not return an open_id', { code: 'provider_error' });
    const account: AccountInfo = {
      externalAccountId: id,
      displayName: str(user.display_name) ?? 'TikTok account',
      meta: compact({ openId: id, unionId: str(user.union_id), refreshExpiresInSec: num(body.refresh_expires_in) }),
    };
    const avatar = str(user.avatar_url);
    if (avatar) account.avatarUrl = avatar;
    return { tokens, accounts: [account] };
  },

  async refresh(ctx, tokens) {
    if (!tokens.refreshToken) {
      throw new PublishError('No TikTok refresh token stored; reconnect the account.', { code: 'auth_invalid', needsReconnect: true });
    }
    const res = await httpRequest(ctx, {
      url: TOKEN_URL,
      form: {
        client_key: ctx.config.clientId,
        client_secret: ctx.config.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      },
      mapError: tiktokError,
    });
    const body = asRecord(res.data);
    if (!str(body.access_token)) {
      throw new PublishError(`TikTok token refresh failed: ${str(body.error_description) ?? str(body.error) ?? 'unknown'}`, {
        code: 'auth_invalid',
        needsReconnect: true,
        providerPayload: { error: body.error, error_description: body.error_description },
      });
    }
    return tokenSetFromOAuth(ctx, body, { refreshToken: tokens.refreshToken, scopes: tokens.scopes.length ? tokens.scopes : parseScopes(TIKTOK_SCOPES) });
  },

  validate(render, meta, account) {
    const creator = creatorInfoFromAccount(account);
    const issues = validateCommon('tiktok', render, meta, {
      videoCodecs: ['h264', 'hevc'],
      ...(creator ? { maxDurationSec: creator.maxVideoPostDurationSec } : {}),
    });
    const parsed = parseOptions(tiktokOptionsSchema, meta.options);
    issues.push(...parsed.issues);
    const o = parsed.data;
    if (!o) return issues;

    if (!o.privacyLevel) {
      issues.push(issue('options.privacyLevel', 'privacy_required', 'Choose who can view this video. TikTok does not allow a default privacy setting.'));
    } else if (creator && !creator.privacyLevelOptions.includes(o.privacyLevel)) {
      issues.push(issue('options.privacyLevel', 'privacy_not_available', `"${o.privacyLevel}" is not available for this TikTok account right now.`));
    }
    if (!o.consentAccepted) {
      issues.push(issue('options.consentAccepted', 'consent_required', `The user must agree before posting: "${getTikTokConsentText(o)}".`));
    }
    if ((o.brandContentToggle || o.brandOrganicToggle) && !o.discloseCommercialContent) {
      issues.push(issue('options.discloseCommercialContent', 'disclosure_inconsistent', 'Turn on "Disclose video content" to use the brand toggles.'));
    }
    if (o.discloseCommercialContent && !o.brandContentToggle && !o.brandOrganicToggle) {
      issues.push(issue('options.discloseCommercialContent', 'disclosure_incomplete', TIKTOK_DISCLOSURE_PROMPT));
    }
    if (o.brandContentToggle && o.privacyLevel === 'SELF_ONLY') {
      issues.push(issue('options.privacyLevel', 'branded_content_private', TIKTOK_BRANDED_PRIVACY_NOTICE));
    }
    if (creator) {
      if (creator.commentDisabled && !o.disableComment) {
        issues.push(issue('options.disableComment', 'interaction_disabled_by_creator', 'Comments are disabled in the creator\'s TikTok settings; the post will have comments off.', 'warning'));
      }
      if (creator.duetDisabled && !o.disableDuet) {
        issues.push(issue('options.disableDuet', 'interaction_disabled_by_creator', 'Duet is disabled in the creator\'s TikTok settings; the post will have Duet off.', 'warning'));
      }
      if (creator.stitchDisabled && !o.disableStitch) {
        issues.push(issue('options.disableStitch', 'interaction_disabled_by_creator', 'Stitch is disabled in the creator\'s TikTok settings; the post will have Stitch off.', 'warning'));
      }
    }
    return issues;
  },

  async publish(ctx, { tokens, account, render, meta }) {
    const parsed = parseOptions(tiktokOptionsSchema, meta.options);
    const o = parsed.data;
    if (!o) throw new PublishError(`Invalid TikTok options: ${parsed.issues.map((i) => i.message).join('; ')}`, { code: 'invalid_options' });
    if (!o.privacyLevel) throw new PublishError('TikTok privacy level must be chosen explicitly.', { code: 'privacy_required' });
    if (!o.consentAccepted) throw new PublishError('TikTok posting consent was not accepted.', { code: 'consent_required' });
    if (o.brandContentToggle && o.privacyLevel === 'SELF_ONLY') {
      throw new PublishError(TIKTOK_BRANDED_PRIVACY_NOTICE, { code: 'branded_content_private' });
    }

    // Required by TikTok before every post: the latest creator info.
    const creator = await getTikTokCreatorInfo(ctx, tokens);
    if (!creator.privacyLevelOptions.includes(o.privacyLevel)) {
      throw new PublishError(`Privacy level ${o.privacyLevel} is not available for this creator (options: ${creator.privacyLevelOptions.join(', ')}).`, {
        code: 'privacy_level_option_mismatch',
      });
    }
    if (render.durationSec > creator.maxVideoPostDurationSec) {
      throw new PublishError(`Video is ${render.durationSec}s; this creator can post at most ${creator.maxVideoPostDurationSec}s.`, {
        code: 'duration_too_long',
      });
    }

    const postInfo = compact({
      title: composeCaption('tiktok', meta),
      privacy_level: o.privacyLevel,
      disable_comment: o.disableComment || creator.commentDisabled,
      disable_duet: o.disableDuet || creator.duetDisabled,
      disable_stitch: o.disableStitch || creator.stitchDisabled,
      video_cover_timestamp_ms: meta.coverTimestampMs,
      brand_content_toggle: o.brandContentToggle,
      brand_organic_toggle: o.brandOrganicToggle,
      is_aigc: o.isAigc,
    });
    const initUrl = `${API}/v2/post/publish/video/init/`;
    const usePull = !!render.url && ctx.config.extra?.tiktokSource === 'pull';

    let publishId: string | undefined;
    if (usePull) {
      const data = await tiktokCall(ctx, {
        method: 'POST',
        url: initUrl,
        bearer: tokens.accessToken,
        headers: JSON_HEADERS,
        json: { post_info: postInfo, source_info: { source: 'PULL_FROM_URL', video_url: render.url } },
      });
      publishId = str(data.publish_id);
    } else {
      publishId = await withAssetSource(render, ctx, async (source) => {
        const plan = planTikTokChunks(source.size, extraNum(ctx, 'chunkSizeBytes', 10 * 1024 * 1024));
        const data = await tiktokCall(ctx, {
          method: 'POST',
          url: initUrl,
          bearer: tokens.accessToken,
          headers: JSON_HEADERS,
          json: {
            post_info: postInfo,
            source_info: { source: 'FILE_UPLOAD', video_size: source.size, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunkCount },
          },
        });
        const uploadUrl = str(data.upload_url);
        const id = str(data.publish_id);
        if (!uploadUrl || !id) throw new PublishError('TikTok init did not return an upload_url', { code: 'provider_error', providerPayload: data });
        await uploadInChunks(ctx, source, plan.ranges, async (chunk) => {
          // 206 = more chunks expected, 201 = all received.
          await httpRequest(ctx, {
            method: 'PUT',
            url: uploadUrl,
            headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${chunk.start}-${chunk.end}/${chunk.total}` },
            body: chunk.data,
            mapError: tiktokError,
          });
        });
        return id;
      });
    }
    if (!publishId) throw new PublishError('TikTok init did not return a publish_id', { code: 'provider_error' });
    const id = publishId;

    const polled = await pollUntil(
      ctx,
      async () => {
        const s = await fetchPublishStatus(ctx, tokens, id);
        return { done: s.status.status !== 'processing', value: s };
      },
      pollOptionsOf(ctx, { maxAttempts: 12, intervalMs: 5000 }),
    );
    const final = polled.value;
    if (final.status.status === 'failed') {
      throw new PublishError(final.status.error ?? 'TikTok publish failed', { code: 'publish_failed', providerPayload: final.raw });
    }
    if (final.status.status === 'published') {
      const url = postUrl(account, final.postId) ?? (creator.creatorUsername ? postUrl({ ...account, username: creator.creatorUsername }, final.postId) : undefined);
      return { externalId: id, status: 'published', ...(url ? { url } : {}) };
    }
    return { externalId: id, status: 'processing' };
  },

  async getStatus(ctx, { tokens, account, externalId }) {
    const s = await fetchPublishStatus(ctx, tokens, externalId);
    const url = postUrl(account, s.postId);
    return { ...s.status, ...(url ? { url } : {}) };
  },

  /**
   * externalId is the publish_id. Metrics need the public video id, which TikTok only exposes
   * (via status/fetch) once a PUBLIC post passed moderation; private posts have no metrics here.
   */
  async fetchMetrics(ctx, { tokens, externalId }) {
    let videoId: string | undefined = isNumericId(externalId) ? externalId : undefined;
    if (!videoId) videoId = (await fetchPublishStatus(ctx, tokens, externalId)).postId;
    if (!videoId) return { raw: { unavailable: 'no public video id for this publish_id yet' } };
    const data = await tiktokCall(ctx, {
      method: 'POST',
      url: `${API}/v2/video/query/`,
      query: { fields: 'id,view_count,like_count,comment_count,share_count,duration,share_url' },
      bearer: tokens.accessToken,
      headers: JSON_HEADERS,
      json: { filters: { video_ids: [videoId] } },
    });
    const video = asRecord(asArray(data.videos)[0]);
    return metricsOf({
      views: num(video.view_count),
      likes: num(video.like_count),
      comments: num(video.comment_count),
      shares: num(video.share_count),
      raw: data,
    });
  },
};
