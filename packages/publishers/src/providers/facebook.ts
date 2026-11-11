/**
 * Facebook adapter (Page Reels).
 *
 * Docs:
 *  - Reels publishing: https://developers.facebook.com/docs/video-api/guides/reels-publishing
 *  - Video insights:   https://developers.facebook.com/docs/graph-api/reference/video/video_insights/
 *
 * Flow: POST /{page-id}/video_reels upload_phase=start -> upload to rupload.facebook.com
 * (binary with offset/file_size headers by default; `file_url` header only when the render has a
 * public url and no local file) -> upload_phase=finish video_state=PUBLISHED -> GET /{video-id}?fields=status.
 *
 * publish/getStatus/fetchMetrics must be called with the PAGE access token
 * (connect() returns it in accountTokens[pageId]).
 */
import { z } from 'zod';
import { composeCaption } from '../caption';
import { PublishError } from '../errors';
import { httpRequest, pollOptionsOf, pollUntil, withAssetSource } from '../http';
import { PLATFORM_LIMITS } from '../limits';
import type { AccountInfo, PostStatus, Publisher, PublisherContext, TokenSet } from '../types';
import { asRecord, compact, metricsOf, num, pick, str } from '../util';
import { issue, parseOptions, validateCommon } from '../validate';
import { fetchMetaPages, graphUrl, graphVersion, insightsMap, metaAuthUrl, metaError, metaExchangeCode, metaRefresh, ruploadBinary, ruploadFromUrl } from './meta';

export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'read_insights', 'business_management'];

export const facebookOptionsSchema = z.object({
  title: z.string().max(255).optional(),
  isAiGenerated: z.boolean().optional(),
});
export type FacebookOptions = z.infer<typeof facebookOptionsSchema>;

function pageId(account: AccountInfo): string {
  return str(account.meta.pageId) ?? account.externalAccountId;
}

const reelUrl = (videoId: string): string => `https://www.facebook.com/reel/${videoId}`;

async function videoStatus(ctx: PublisherContext, token: string, videoId: string): Promise<PostStatus> {
  const res = await httpRequest(ctx, { url: graphUrl(ctx, videoId), query: { fields: 'status' }, bearer: token, mapError: metaError });
  const status = asRecord(asRecord(res.data).status);
  const videoStatusValue = str(status.video_status);
  const publish = str(pick(status, 'publishing_phase', 'publish_status')) ?? str(pick(status, 'publishing_phase', 'status'));
  const phaseError =
    str(pick(status, 'processing_phase', 'error', 'message')) ??
    str(pick(status, 'publishing_phase', 'error', 'message')) ??
    str(pick(status, 'uploading_phase', 'error', 'message')) ??
    str(pick(status, 'processing_phase', 'errors', 0, 'message')) ??
    str(pick(status, 'uploading_phase', 'errors', 0, 'message'));
  if (videoStatusValue === 'error' || videoStatusValue === 'upload_failed' || videoStatusValue === 'expired' || publish === 'error') {
    return { status: 'failed', error: `Facebook Reel failed (${videoStatusValue ?? publish}): ${phaseError ?? 'no details'}` };
  }
  if (videoStatusValue === 'ready' && (publish === 'published' || publish === 'complete')) {
    return { status: 'published', url: reelUrl(videoId) };
  }
  return { status: 'processing', url: reelUrl(videoId) };
}

export const facebookPublisher: Publisher = {
  provider: 'facebook',
  limits: PLATFORM_LIMITS.facebook,

  getAuthUrl(ctx, args) {
    return metaAuthUrl(ctx, args, FACEBOOK_SCOPES);
  },

  async connect(ctx, args) {
    const tokens = await metaExchangeCode(ctx, args.code, FACEBOOK_SCOPES);
    const pages = await fetchMetaPages(ctx, tokens.accessToken);
    const accounts: AccountInfo[] = [];
    const accountTokens: Record<string, TokenSet> = {};
    for (const page of pages) {
      if (!page.accessToken) continue;
      const account: AccountInfo = { externalAccountId: page.id, displayName: page.name, meta: { pageId: page.id, tasks: page.tasks } };
      if (page.pictureUrl) account.avatarUrl = page.pictureUrl;
      accounts.push(account);
      // Page tokens derived from a long-lived user token do not expire.
      accountTokens[page.id] = { accessToken: page.accessToken, scopes: tokens.scopes };
    }
    if (accounts.length === 0) {
      throw new PublishError('No Facebook Pages found for this user. Reels can only be published to Pages you manage.', { code: 'no_accounts' });
    }
    return { tokens, accounts, accountTokens };
  },

  /** Refreshes the long-lived USER token. Page tokens have no expiry and are never refreshed. */
  refresh: metaRefresh,

  validate(render, meta) {
    const issues = validateCommon('facebook', render, meta, { videoCodecs: ['h264', 'hevc', 'vp9', 'av1'] });
    issues.push(...parseOptions(facebookOptionsSchema, meta.options).issues);
    if (render.width > 0 && render.height > 0 && (render.width < 540 || render.height < 960)) {
      issues.push(issue('render.width', 'resolution_too_low', 'Facebook Reels need at least 540x960 (1080x1920 recommended).'));
    }
    return issues;
  },

  async publish(ctx, { tokens, account, render, meta }) {
    const parsed = parseOptions(facebookOptionsSchema, meta.options);
    if (!parsed.data) throw new PublishError(`Invalid Facebook options: ${parsed.issues.map((i) => i.message).join('; ')}`, { code: 'invalid_options' });
    const options = parsed.data;
    const token = tokens.accessToken;
    const reelsEndpoint = graphUrl(ctx, `${pageId(account)}/video_reels`);

    const start = await httpRequest(ctx, { url: reelsEndpoint, form: { upload_phase: 'start' }, bearer: token, mapError: metaError });
    const videoId = str(asRecord(start.data).video_id);
    if (!videoId) throw new PublishError('Facebook did not return a video_id', { code: 'provider_error', providerPayload: start.data });
    const uploadUrl = str(asRecord(start.data).upload_url) ?? `https://rupload.facebook.com/video-upload/${graphVersion(ctx)}/${videoId}`;

    if (!render.filePath && render.url) {
      await ruploadFromUrl(ctx, uploadUrl, token, render.url);
    } else {
      await withAssetSource(render, ctx, (source) => ruploadBinary(ctx, uploadUrl, token, source));
    }

    await httpRequest(ctx, {
      url: reelsEndpoint,
      form: compact({
        video_id: videoId,
        upload_phase: 'finish',
        video_state: 'PUBLISHED',
        description: composeCaption('facebook', meta),
        title: options.title ?? meta.title,
        is_ai_generated: options.isAiGenerated,
      }) as Record<string, string | boolean>,
      bearer: token,
      mapError: metaError,
    });

    const polled = await pollUntil(
      ctx,
      async () => {
        const s = await videoStatus(ctx, token, videoId);
        return { done: s.status !== 'processing', value: s };
      },
      pollOptionsOf(ctx, { maxAttempts: 12, intervalMs: 5000 }),
    );
    if (polled.value.status === 'failed') {
      throw new PublishError(polled.value.error ?? 'Facebook Reel failed', { code: 'processing_failed' });
    }
    return { externalId: videoId, status: polled.value.status === 'published' ? 'published' : 'processing', url: reelUrl(videoId) };
  },

  getStatus(ctx, { tokens, externalId }) {
    return videoStatus(ctx, tokens.accessToken, externalId);
  },

  async fetchMetrics(ctx, { tokens, externalId }) {
    const res = await httpRequest(ctx, { url: graphUrl(ctx, `${externalId}/video_insights`), bearer: tokens.accessToken, mapError: metaError });
    const m = insightsMap(res.data);
    const reactions = asRecord(m.post_video_likes_by_reaction_type);
    const reactionTotal = Object.values(reactions).reduce<number>((sum, v) => sum + (num(v) ?? 0), 0);
    const social = asRecord(m.post_video_social_actions);
    const watchMs = num(m.post_video_view_time);
    return metricsOf({
      views: num(m.fb_reels_total_plays) ?? num(m.blue_reels_play_count) ?? num(m.total_video_views),
      impressions: num(m.post_impressions_unique) ?? num(m.total_video_impressions),
      likes: Object.keys(reactions).length > 0 ? reactionTotal : undefined,
      comments: num(social.COMMENT) ?? num(social.comment),
      shares: num(social.SHARE) ?? num(social.share),
      watchTimeSec: watchMs !== undefined ? Math.round(watchMs / 1000) : undefined,
      raw: res.data,
    });
  },
};
