/**
 * LinkedIn adapter (OAuth 2.0, Videos API multipart upload, Posts API).
 *
 * Docs (verified 2026-11 unless noted):
 *  - OAuth:      https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 *  - Videos API: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 *  - Posts API:  https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 *  - Social actions (likes/comments summary):
 *                https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/network-update-social-actions
 *  - Member post analytics (r_member_postAnalytics; request shape NOT verified against live API):
 *                https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics
 *
 * Metrics limitations: for member (personal) posts LinkedIn only exposes analytics to apps with the
 * Community Management API scopes (r_member_social / r_member_postAnalytics). Without them
 * fetchMetrics returns `{ raw: { unavailable: ... } }` instead of failing.
 */
import { z } from 'zod';
import { composeCaption } from '../caption';
import { PublishError } from '../errors';
import { httpRequest, pollOptionsOf, pollUntil, uploadInChunks, withAssetSource, type ByteRange, type ErrorMapper } from '../http';
import { LINKEDIN_MIN_SIZE_BYTES, PLATFORM_LIMITS } from '../limits';
import { buildAuthUrl, tokenSetFromOAuth } from '../oauth';
import type { AccountInfo, Publisher, PublisherContext } from '../types';
import { asArray, asRecord, metricsOf, num, pick, str } from '../util';
import { parseOptions, validateCommon } from '../validate';

const AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const REST = 'https://api.linkedin.com/rest';

/** Default LinkedIn-Version header (YYYYMM). Versions sunset after ~1 year: override with config.extra.linkedinVersion. */
export const DEFAULT_LINKEDIN_VERSION = '202610';

export const LINKEDIN_SCOPES = ['openid', 'profile', 'w_member_social'];
/** Optional: add via config.extra.linkedinScopes (space separated) once the app has Community Management API access. */
export const LINKEDIN_ORG_SCOPES = ['r_organization_social', 'w_organization_social', 'rw_organization_admin'];

export const linkedinOptionsSchema = z.object({
  visibility: z.enum(['PUBLIC', 'CONNECTIONS']).default('PUBLIC'),
  title: z.string().max(200).optional(),
});
export type LinkedInOptions = z.infer<typeof linkedinOptionsSchema>;

function scopesOf(ctx: PublisherContext): string[] {
  const extra = (ctx.config.extra?.linkedinScopes ?? '').split(/[\s,]+/).filter(Boolean);
  return Array.from(new Set([...LINKEDIN_SCOPES, ...extra]));
}

function restHeaders(ctx: PublisherContext): Record<string, string> {
  return {
    'LinkedIn-Version': ctx.config.extra?.linkedinVersion?.trim() || DEFAULT_LINKEDIN_VERSION,
    'X-Restli-Protocol-Version': '2.0.0',
  };
}

const linkedinError: ErrorMapper = (info) => {
  const body = asRecord(info.body);
  const message = str(body.message) ?? str(body.error_description) ?? `HTTP ${info.status}`;
  const code = str(body.code) ?? str(body.error) ?? '';
  const base = { status: info.status, providerPayload: info.body };
  if (info.status === 401 || /REVOKED_ACCESS_TOKEN|EXPIRED_ACCESS_TOKEN|INVALID_ACCESS_TOKEN|invalid_grant/i.test(`${code} ${str(body.serviceErrorCode) ?? ''}`)) {
    return new PublishError(`LinkedIn authorization failed: ${message}`, { ...base, code: 'auth_invalid', needsReconnect: true });
  }
  if (info.status === 403 && /ACCESS_DENIED|permission|scope/i.test(`${code} ${message}`)) {
    return new PublishError(`LinkedIn permission missing: ${message}`, { ...base, code: 'permission_denied', needsReconnect: true });
  }
  if (info.status === 422 && /duplicate/i.test(message)) {
    return new PublishError(`LinkedIn rejected duplicate content: ${message}`, { ...base, code: 'duplicate_content' });
  }
  if (info.status === 426 || /NONEXISTENT_VERSION|VERSION_MISSING/i.test(code)) {
    return new PublishError(`LinkedIn API version is no longer supported; set config.extra.linkedinVersion. ${message}`, { ...base, code: 'api_version_unsupported' });
  }
  return undefined;
};

/**
 * Escape LinkedIn "little text format" reserved characters in commentary. `#` is left alone so
 * plain #hashtags keep working. https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
 */
export function escapeLinkedInText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (ch) => `\\${ch}`);
}

const enc = encodeURIComponent;

function authorUrn(account: AccountInfo): string {
  return str(account.meta.authorUrn) ?? `urn:li:person:${account.externalAccountId}`;
}

export const linkedinPublisher: Publisher = {
  provider: 'linkedin',
  limits: PLATFORM_LIMITS.linkedin,

  getAuthUrl(ctx, args) {
    return buildAuthUrl(AUTH_URL, {
      response_type: 'code',
      client_id: ctx.config.clientId,
      redirect_uri: ctx.config.redirectUri,
      state: args.state,
      scope: scopesOf(ctx).join(' '),
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
      },
      mapError: linkedinError,
    });
    const tokens = tokenSetFromOAuth(ctx, res.data, { scopes: scopesOf(ctx) });
    const info = await httpRequest(ctx, { url: 'https://api.linkedin.com/v2/userinfo', bearer: tokens.accessToken, mapError: linkedinError });
    const profile = asRecord(info.data);
    const sub = str(profile.sub);
    if (!sub) throw new PublishError('LinkedIn did not return the member id', { code: 'provider_error', providerPayload: info.data });
    const member: AccountInfo = {
      externalAccountId: sub,
      displayName: str(profile.name) ?? ([str(profile.given_name), str(profile.family_name)].filter(Boolean).join(' ') || sub),
      meta: { authorUrn: `urn:li:person:${sub}`, kind: 'member' },
    };
    const picture = str(profile.picture);
    if (picture) member.avatarUrl = picture;
    const accounts: AccountInfo[] = [member];

    // Company pages (only when organization scopes were granted). Best effort.
    if (tokens.scopes.some((s) => s === 'w_organization_social')) {
      try {
        const acls = await httpRequest(ctx, {
          url: `${REST}/organizationAcls`,
          query: { q: 'roleAssignee', role: 'ADMINISTRATOR', state: 'APPROVED' },
          headers: restHeaders(ctx),
          bearer: tokens.accessToken,
          mapError: linkedinError,
        });
        for (const el of asArray(asRecord(acls.data).elements)) {
          const urn = str(asRecord(el).organization);
          const id = urn?.split(':').pop();
          if (!urn || !id) continue;
          accounts.push({ externalAccountId: id, displayName: `LinkedIn Page ${id}`, meta: { authorUrn: urn, kind: 'organization' } });
        }
      } catch (err) {
        if (err instanceof PublishError && err.status === 401) throw err;
      }
    }
    return { tokens, accounts };
  },

  /** LinkedIn only issues refresh tokens to approved apps; without one the member must reconnect (~60 days). */
  async refresh(ctx, tokens) {
    if (!tokens.refreshToken) {
      throw new PublishError('LinkedIn access token expired and no refresh token is available; reconnect the account.', {
        code: 'auth_invalid',
        needsReconnect: true,
      });
    }
    const res = await httpRequest(ctx, {
      url: TOKEN_URL,
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: ctx.config.clientId,
        client_secret: ctx.config.clientSecret,
      },
      mapError: (info) =>
        info.status === 400
          ? new PublishError('LinkedIn refresh token is invalid or expired; reconnect the account.', {
              code: 'auth_invalid',
              needsReconnect: true,
              status: 400,
              providerPayload: info.body,
            })
          : linkedinError(info),
    });
    return tokenSetFromOAuth(ctx, res.data, { refreshToken: tokens.refreshToken, scopes: tokens.scopes });
  },

  validate(render, meta) {
    const issues = validateCommon('linkedin', render, meta, { minSizeBytes: LINKEDIN_MIN_SIZE_BYTES });
    issues.push(...parseOptions(linkedinOptionsSchema, meta.options).issues);
    return issues;
  },

  async publish(ctx, { tokens, account, render, meta }) {
    const parsed = parseOptions(linkedinOptionsSchema, meta.options);
    if (!parsed.data) throw new PublishError(`Invalid LinkedIn options: ${parsed.issues.map((i) => i.message).join('; ')}`, { code: 'invalid_options' });
    const options = parsed.data;
    const token = tokens.accessToken;
    const headers = restHeaders(ctx);
    const owner = authorUrn(account);

    const videoUrn = await withAssetSource(render, ctx, async (source) => {
      const init = await httpRequest(ctx, {
        url: `${REST}/videos`,
        query: { action: 'initializeUpload' },
        headers,
        bearer: token,
        json: { initializeUploadRequest: { owner, fileSizeBytes: source.size, uploadCaptions: false, uploadThumbnail: false } },
        mapError: linkedinError,
      });
      const value = asRecord(asRecord(init.data).value);
      const urn = str(value.video);
      const instructions = asArray(value.uploadInstructions);
      if (!urn || instructions.length === 0) {
        throw new PublishError('LinkedIn initializeUpload returned no upload instructions', { code: 'provider_error', providerPayload: init.data });
      }
      const ranges: ByteRange[] = [];
      const urls: string[] = [];
      instructions.forEach((raw, index) => {
        const ins = asRecord(raw);
        const start = num(ins.firstByte);
        const end = num(ins.lastByte);
        const url = str(ins.uploadUrl);
        if (start === undefined || end === undefined || !url) {
          throw new PublishError('LinkedIn returned a malformed upload instruction', { code: 'provider_error', providerPayload: raw });
        }
        ranges.push({ index, start, end: Math.min(end, source.size - 1) });
        urls.push(url);
      });
      const etags: string[] = [];
      await uploadInChunks(ctx, source, ranges, async (chunk) => {
        const res = await httpRequest(ctx, {
          method: 'PUT',
          url: urls[chunk.index] ?? '',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: chunk.data,
          mapError: linkedinError,
        });
        const etag = res.headers.get('etag');
        if (!etag) throw new PublishError('LinkedIn part upload returned no ETag', { code: 'provider_error', retryable: true });
        etags.push(etag.replace(/^"|"$/g, ''));
      });
      await httpRequest(ctx, {
        url: `${REST}/videos`,
        query: { action: 'finalizeUpload' },
        headers,
        bearer: token,
        json: { finalizeUploadRequest: { video: urn, uploadToken: str(value.uploadToken) ?? '', uploadedPartIds: etags } },
        mapError: linkedinError,
      });
      return urn;
    });

    const polled = await pollUntil(
      ctx,
      async () => {
        const res = await httpRequest(ctx, { url: `${REST}/videos/${enc(videoUrn)}`, headers, bearer: token, mapError: linkedinError });
        const body = asRecord(res.data);
        const status = str(body.status) ?? 'PROCESSING';
        return { done: status === 'AVAILABLE' || status === 'PROCESSING_FAILED', value: { status, reason: str(body.processingFailureReason) } };
      },
      pollOptionsOf(ctx, { maxAttempts: 30, intervalMs: 4000 }),
    );
    if (polled.value.status === 'PROCESSING_FAILED') {
      throw new PublishError(`LinkedIn could not process the video: ${polled.value.reason ?? 'unknown reason'}`, { code: 'processing_failed' });
    }
    if (!polled.done) {
      throw new PublishError('LinkedIn is still processing the video; retry the publish later.', { code: 'media_processing_timeout', retryable: true, retryAfterSec: 60 });
    }

    const post = await httpRequest(ctx, {
      url: `${REST}/posts`,
      headers,
      bearer: token,
      json: {
        author: owner,
        commentary: escapeLinkedInText(composeCaption('linkedin', meta)),
        visibility: options.visibility,
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        content: { media: { title: options.title ?? meta.title ?? 'Video', id: videoUrn } },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
      mapError: linkedinError,
    });
    const id = post.headers.get('x-restli-id') ?? str(asRecord(post.data).id);
    if (!id) throw new PublishError('LinkedIn did not return a post id (x-restli-id)', { code: 'provider_error' });
    return { externalId: id, status: 'published', url: `https://www.linkedin.com/feed/update/${id}/` };
  },

  async getStatus(ctx, { tokens, externalId }) {
    const url = `https://www.linkedin.com/feed/update/${externalId}/`;
    try {
      const res = await httpRequest(ctx, { url: `${REST}/posts/${enc(externalId)}`, headers: restHeaders(ctx), bearer: tokens.accessToken, mapError: linkedinError });
      const state = str(asRecord(res.data).lifecycleState);
      if (state === 'PUBLISH_FAILED') return { status: 'failed', error: 'LinkedIn failed to publish the post.' };
      if (state === 'PUBLISH_REQUESTED' || state === 'DRAFT') return { status: 'processing', url };
      return { status: 'published', url };
    } catch (err) {
      if (err instanceof PublishError && err.status === 404) return { status: 'failed', error: 'Post not found (deleted?).' };
      throw err;
    }
  },

  async fetchMetrics(ctx, { tokens, externalId }) {
    const headers = restHeaders(ctx);
    const raw: Record<string, unknown> = {};
    let likes: number | undefined;
    let comments: number | undefined;
    let impressions: number | undefined;
    const tolerate = (err: unknown, key: string): void => {
      // Missing analytics permissions are expected for most apps: report as unavailable.
      if (err instanceof PublishError && (err.status === 403 || err.status === 404 || err.status === 400 || err.code === 'permission_denied') && err.status !== 401) {
        raw[key] = { unavailable: err.message };
        return;
      }
      throw err;
    };
    try {
      const res = await httpRequest(ctx, { url: `${REST}/socialActions/${enc(externalId)}`, headers, bearer: tokens.accessToken, mapError: linkedinError });
      raw.socialActions = res.data;
      likes = num(pick(res.data, 'likesSummary', 'totalLikes'));
      comments = num(pick(res.data, 'commentsSummary', 'aggregatedTotalComments')) ?? num(pick(res.data, 'commentsSummary', 'totalFirstLevelComments'));
    } catch (err) {
      tolerate(err, 'socialActions');
    }
    if (tokens.scopes.includes('r_member_postAnalytics')) {
      try {
        const kind = externalId.includes(':ugcPost:') ? 'ugc' : 'share';
        const res = await httpRequest(ctx, {
          // Rest.li URNs inside the tuple must stay percent-encoded, so the URL is built by hand.
          url: `${REST}/memberCreatorPostAnalytics?q=entity&entity=(${kind}:${enc(externalId)})&queryType=IMPRESSION&aggregation=TOTAL`,
          headers,
          bearer: tokens.accessToken,
          mapError: linkedinError,
        });
        raw.memberCreatorPostAnalytics = res.data;
        impressions = num(pick(res.data, 'elements', 0, 'count'));
      } catch (err) {
        tolerate(err, 'memberCreatorPostAnalytics');
      }
    }
    return metricsOf({ likes, comments, impressions, raw });
  },
};
