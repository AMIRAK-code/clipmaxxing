/**
 * Instagram adapter (Instagram API with Facebook Login, Reels publishing).
 *
 * Docs:
 *  - Content publishing:  https://developers.facebook.com/docs/instagram-platform/content-publishing
 *  - Resumable uploads:   https://developers.facebook.com/docs/instagram-platform/content-publishing/resumable-uploads
 *  - IG User media:       https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 *  - Publishing limit:    https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit
 *  - Media insights:      https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
 *
 * Default path: resumable binary upload of the local render to rupload.facebook.com.
 * `video_url` is used only when the render has a public url and no local filePath.
 *
 * externalId: the published media id. If the container is still processing when the poll cap is
 * hit, publish() returns `container:<id>`; getStatus() then finishes the publish and returns the
 * new media id in PostStatus.externalId.
 */
import { z } from 'zod';
import { composeCaption } from '../caption';
import { PublishError } from '../errors';
import { httpRequest, pollOptionsOf, pollUntil, withAssetSource } from '../http';
import { INSTAGRAM_RECOMMENDED_MAX_SEC, PLATFORM_LIMITS } from '../limits';
import type { AccountInfo, PostStatus, Publisher, PublisherContext, TokenSet } from '../types';
import { asRecord, compact, metricsOf, num, pick, str } from '../util';
import { issue, parseOptions, validateCommon } from '../validate';
import { fetchMetaPages, graphUrl, graphVersion, insightsMap, metaAuthUrl, metaError, metaExchangeCode, metaRefresh, ruploadBinary } from './meta';

export const INSTAGRAM_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
];

export const instagramOptionsSchema = z.object({
  shareToFeed: z.boolean().default(true),
  collaborators: z.array(z.string().min(1)).max(3).optional(),
  audioName: z.string().min(1).optional(),
  locationId: z.string().regex(/^\d+$/).optional(),
});
export type InstagramOptions = z.infer<typeof instagramOptionsSchema>;

const CONTAINER_PREFIX = 'container:';

function igUserId(account: AccountInfo): string {
  return str(account.meta.igUserId) ?? account.externalAccountId;
}

async function containerStatus(ctx: PublisherContext, token: string, containerId: string): Promise<{ code: string; detail?: string }> {
  const res = await httpRequest(ctx, {
    url: graphUrl(ctx, containerId),
    query: { fields: 'status_code,status' },
    bearer: token,
    mapError: metaError,
  });
  const body = asRecord(res.data);
  const detail = str(body.status);
  return { code: str(body.status_code) ?? 'IN_PROGRESS', ...(detail ? { detail } : {}) };
}

async function publishContainer(ctx: PublisherContext, token: string, igId: string, containerId: string): Promise<{ id: string; url?: string }> {
  const res = await httpRequest(ctx, {
    url: graphUrl(ctx, `${igId}/media_publish`),
    form: { creation_id: containerId },
    bearer: token,
    mapError: metaError,
  });
  const id = str(asRecord(res.data).id);
  if (!id) throw new PublishError('Instagram media_publish returned no media id', { code: 'provider_error', providerPayload: res.data });
  const url = await permalink(ctx, token, id).catch(() => undefined);
  return { id, ...(url ? { url } : {}) };
}

async function permalink(ctx: PublisherContext, token: string, mediaId: string): Promise<string | undefined> {
  const res = await httpRequest(ctx, { url: graphUrl(ctx, mediaId), query: { fields: 'id,permalink' }, bearer: token, mapError: metaError });
  return str(asRecord(res.data).permalink);
}

async function assertPublishingQuota(ctx: PublisherContext, token: string, igId: string): Promise<void> {
  const res = await httpRequest(ctx, {
    url: graphUrl(ctx, `${igId}/content_publishing_limit`),
    query: { fields: 'config,quota_usage' },
    bearer: token,
    mapError: metaError,
  });
  const row = pick(res.data, 'data', 0);
  const usage = num(pick(row, 'quota_usage'));
  const total = num(pick(row, 'config', 'quota_total'));
  if (usage !== undefined && total !== undefined && usage >= total) {
    throw new PublishError(`Instagram publishing limit reached (${usage}/${total} posts in the rolling 24 hours).`, {
      code: 'quota_exceeded',
      retryable: true,
      retryAfterSec: 3600,
      providerPayload: res.data,
    });
  }
}

export const instagramPublisher: Publisher = {
  provider: 'instagram',
  limits: PLATFORM_LIMITS.instagram,

  getAuthUrl(ctx, args) {
    return metaAuthUrl(ctx, args, INSTAGRAM_SCOPES);
  },

  async connect(ctx, args) {
    const tokens = await metaExchangeCode(ctx, args.code, INSTAGRAM_SCOPES);
    const pages = await fetchMetaPages(ctx, tokens.accessToken);
    const accounts: AccountInfo[] = [];
    for (const page of pages) {
      if (!page.instagram) continue;
      const ig = page.instagram;
      const account: AccountInfo = {
        externalAccountId: ig.id,
        displayName: ig.name ?? ig.username ?? page.name,
        meta: { igUserId: ig.id, pageId: page.id, pageName: page.name },
      };
      if (ig.username) account.username = ig.username;
      if (ig.pictureUrl) account.avatarUrl = ig.pictureUrl;
      accounts.push(account);
    }
    if (accounts.length === 0) {
      throw new PublishError(
        'No Instagram professional account found. The Instagram account must be Business/Creator and linked to a Facebook Page you manage.',
        { code: 'no_accounts' },
      );
    }
    // Publishing uses the long-lived user token; no per-account tokens are needed.
    return { tokens, accounts };
  },

  refresh: metaRefresh,

  validate(render, meta) {
    const issues = validateCommon('instagram', render, meta, { videoCodecs: ['h264', 'hevc'] });
    issues.push(...parseOptions(instagramOptionsSchema, meta.options).issues);
    if (render.durationSec > INSTAGRAM_RECOMMENDED_MAX_SEC && render.durationSec <= PLATFORM_LIMITS.instagram.maxDurationSec) {
      issues.push(
        issue('render.durationSec', 'duration_not_recommended', `Reels longer than ${INSTAGRAM_RECOMMENDED_MAX_SEC}s are not eligible for the Reels tab; keep it at or under ${INSTAGRAM_RECOMMENDED_MAX_SEC}s.`, 'warning'),
      );
    }
    if (render.width > 1920) {
      issues.push(issue('render.width', 'width_too_large', 'Instagram accepts at most 1920 horizontal pixels.'));
    }
    return issues;
  },

  async publish(ctx, { tokens, account, render, meta }) {
    const parsed = parseOptions(instagramOptionsSchema, meta.options);
    if (!parsed.data) throw new PublishError(`Invalid Instagram options: ${parsed.issues.map((i) => i.message).join('; ')}`, { code: 'invalid_options' });
    const options = parsed.data;
    const token = tokens.accessToken;
    const igId = igUserId(account);

    await assertPublishingQuota(ctx, token, igId);

    const useUrl = !render.filePath && !!render.url;
    const form = compact({
      media_type: 'REELS',
      upload_type: useUrl ? undefined : 'resumable',
      video_url: useUrl ? render.url : undefined,
      caption: composeCaption('instagram', meta),
      share_to_feed: options.shareToFeed,
      thumb_offset: meta.coverTimestampMs !== undefined ? Math.round(meta.coverTimestampMs) : undefined,
      cover_url: render.coverUrl,
      collaborators: options.collaborators ? JSON.stringify(options.collaborators) : undefined,
      audio_name: options.audioName,
      location_id: options.locationId,
    }) as Record<string, string | number | boolean>;
    const created = await httpRequest(ctx, { url: graphUrl(ctx, `${igId}/media`), form, bearer: token, mapError: metaError });
    const containerId = str(asRecord(created.data).id);
    if (!containerId) throw new PublishError('Instagram did not return a container id', { code: 'provider_error', providerPayload: created.data });

    if (!useUrl) {
      const uploadUrl = str(asRecord(created.data).uri) ?? `https://rupload.facebook.com/ig-api-upload/${graphVersion(ctx)}/${containerId}`;
      await withAssetSource(render, ctx, (source) => ruploadBinary(ctx, uploadUrl, token, source));
    }

    const polled = await pollUntil(
      ctx,
      async () => {
        const s = await containerStatus(ctx, token, containerId);
        return { done: s.code !== 'IN_PROGRESS', value: s };
      },
      pollOptionsOf(ctx, { maxAttempts: 20, intervalMs: 5000 }),
    );
    const state = polled.value;
    if (state.code === 'ERROR' || state.code === 'EXPIRED') {
      throw new PublishError(`Instagram could not process the video (${state.code}): ${state.detail ?? 'no details'}`, {
        code: 'processing_failed',
        providerPayload: state,
      });
    }
    if (!polled.done) return { externalId: `${CONTAINER_PREFIX}${containerId}`, status: 'processing' };

    const published = await publishContainer(ctx, token, igId, containerId);
    return { externalId: published.id, status: 'published', ...(published.url ? { url: published.url } : {}) };
  },

  async getStatus(ctx, { tokens, account, externalId }): Promise<PostStatus> {
    const token = tokens.accessToken;
    if (externalId.startsWith(CONTAINER_PREFIX)) {
      const containerId = externalId.slice(CONTAINER_PREFIX.length);
      const state = await containerStatus(ctx, token, containerId);
      if (state.code === 'IN_PROGRESS') return { status: 'processing' };
      if (state.code === 'ERROR' || state.code === 'EXPIRED') {
        return { status: 'failed', error: `Instagram could not process the video (${state.code}): ${state.detail ?? 'no details'}` };
      }
      if (state.code === 'PUBLISHED') return { status: 'published' };
      const published = await publishContainer(ctx, token, igUserId(account), containerId);
      return { status: 'published', externalId: published.id, ...(published.url ? { url: published.url } : {}) };
    }
    try {
      const url = await permalink(ctx, token, externalId);
      return { status: 'published', ...(url ? { url } : {}) };
    } catch (err) {
      if (err instanceof PublishError && !err.retryable && !err.needsReconnect) {
        return { status: 'failed', error: err.message };
      }
      throw err;
    }
  },

  async fetchMetrics(ctx, { tokens, externalId }) {
    if (externalId.startsWith(CONTAINER_PREFIX)) return { raw: { unavailable: 'not published yet' } };
    const res = await httpRequest(ctx, {
      url: graphUrl(ctx, `${externalId}/insights`),
      // `plays` / `video_views` are deprecated; `views` replaced them.
      query: { metric: 'views,reach,likes,comments,shares,saved,total_interactions,ig_reels_video_view_total_time' },
      bearer: tokens.accessToken,
      mapError: metaError,
    });
    const m = insightsMap(res.data);
    const watchMs = num(m.ig_reels_video_view_total_time);
    return metricsOf({
      views: num(m.views),
      impressions: num(m.reach),
      likes: num(m.likes),
      comments: num(m.comments),
      shares: num(m.shares),
      saves: num(m.saved),
      watchTimeSec: watchMs !== undefined ? Math.round(watchMs / 1000) : undefined,
      raw: res.data,
    });
  },
};
