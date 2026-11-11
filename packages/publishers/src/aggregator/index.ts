/**
 * Aggregator-backed Publisher ("adapter flag" used until the official apps are approved).
 *
 * Upload-Post (https://docs.upload-post.com):
 *  - POST {base}/api/upload  multipart: user, platform[], video (file or URL), title, description, async_upload
 *    header `Authorization: Apikey <key>`; async response { request_id }
 *  - GET  {base}/api/uploadposts/status?request_id=   -> { status, results: [{ platform, success, ... }] }
 *  - Per-post analytics path below is NOT verified against the docs (best effort, failures tolerated).
 *
 * Ayrshare (https://www.ayrshare.com/docs):
 *  - POST {base}/api/post  JSON { post, platforms, mediaUrls, isVideo, ...Options }  (needs a public URL)
 *    headers `Authorization: Bearer <key>`, optional `Profile-Key`
 *  - GET  {base}/api/post/{id};  POST {base}/api/analytics/post { id, platforms }
 *  - Platform option field names (youTubeOptions/instagramOptions/faceBookOptions/tikTokOptions) follow the
 *    Ayrshare platform pages; only `youTubeOptions.title` was re-verified.
 *
 * The user links their social accounts inside the aggregator dashboard, so connect() returns a
 * synthetic account and there are no OAuth tokens (TokenSet.accessToken is an empty placeholder).
 */
import { composeCaption, composeTitle } from '../caption';
import { PublishError } from '../errors';
import { httpRequest, withAssetSource, type ErrorMapper } from '../http';
import type { AccountInfo, AggregatorConfig, PostMetrics, PostStatus, Provider, Publisher, PublisherContext, PublishArgs, PublishResult } from '../types';
import { asArray, asRecord, bool, compact, metricsOf, num, pick, str, toArrayBuffer } from '../util';
import { validateCommon } from '../validate';

const DEFAULT_BASE: Record<AggregatorConfig['kind'], string> = {
  'upload-post': 'https://api.upload-post.com',
  ayrshare: 'https://api.ayrshare.com',
};

const aggregatorError: ErrorMapper = (info) => {
  // An invalid aggregator API key is a configuration problem, not something the end user can reconnect.
  if (info.status === 401 || info.status === 403) {
    const message = str(asRecord(info.body).message) ?? str(asRecord(info.body).error) ?? `HTTP ${info.status}`;
    return new PublishError(`Aggregator rejected the API key or plan: ${message}`, {
      code: info.status === 401 ? 'aggregator_auth_invalid' : 'aggregator_plan_required',
      status: info.status,
      providerPayload: info.body,
    });
  }
  return undefined;
};

function baseUrl(config: AggregatorConfig): string {
  return (config.baseUrl ?? DEFAULT_BASE[config.kind]).replace(/\/+$/, '');
}

function ayrsharePlatform(provider: Provider): string {
  return provider === 'x' ? 'twitter' : provider;
}

function opt(meta: PublishArgs['meta'], key: string): unknown {
  return meta.options[key];
}

/* ------------------------------ Upload-Post ------------------------------ */

async function uploadPostPublish(ctx: PublisherContext, config: AggregatorConfig, provider: Provider, args: PublishArgs): Promise<PublishResult> {
  const { render, meta, account } = args;
  const user = config.profileKey ?? str(account.meta.profileKey);
  if (!user) throw new PublishError('Upload-Post needs a profile name (AggregatorConfig.profileKey).', { code: 'aggregator_profile_required' });
  const caption = composeCaption(provider, meta);
  const form = new FormData();
  form.set('user', user);
  form.append('platform[]', provider);
  form.set('title', provider === 'youtube' ? composeTitle('youtube', meta) : caption);
  form.set('description', caption);
  form.set('async_upload', 'true');
  const setIf = (key: string, value: unknown): void => {
    if (value !== undefined && value !== null) form.set(key, String(value));
  };
  switch (provider) {
    case 'tiktok':
      setIf('privacy_level', opt(meta, 'privacyLevel'));
      setIf('disable_comment', opt(meta, 'disableComment'));
      setIf('disable_duet', opt(meta, 'disableDuet'));
      setIf('disable_stitch', opt(meta, 'disableStitch'));
      setIf('brand_content_toggle', opt(meta, 'brandContentToggle'));
      setIf('brand_organic_toggle', opt(meta, 'brandOrganicToggle'));
      setIf('is_aigc', opt(meta, 'isAigc'));
      setIf('cover_timestamp', meta.coverTimestampMs);
      setIf('post_mode', 'DIRECT_POST');
      break;
    case 'youtube':
      setIf('privacyStatus', opt(meta, 'privacyStatus'));
      setIf('selfDeclaredMadeForKids', opt(meta, 'madeForKids'));
      setIf('categoryId', opt(meta, 'categoryId'));
      setIf('containsSyntheticMedia', opt(meta, 'containsSyntheticMedia'));
      break;
    case 'instagram':
      form.set('media_type', 'REELS');
      setIf('share_to_feed', opt(meta, 'shareToFeed'));
      setIf('thumb_offset', meta.coverTimestampMs);
      break;
    case 'facebook':
      form.set('facebook_media_type', 'REELS');
      setIf('facebook_page_id', account.meta.pageId);
      setIf('facebook_title', opt(meta, 'title') ?? meta.title);
      break;
    case 'linkedin':
      setIf('visibility', opt(meta, 'visibility'));
      setIf('target_linkedin_page_id', account.meta.linkedinPageId);
      break;
    case 'x':
      setIf('reply_settings', opt(meta, 'replySettings'));
      break;
  }
  if (render.filePath) {
    // Upload-Post takes the file itself; it is read into memory once for the multipart body.
    const bytes = await withAssetSource(render, ctx, (source) => source.readChunk(0, source.size));
    form.set('video', new Blob([toArrayBuffer(bytes)], { type: 'video/mp4' }), 'video.mp4');
  } else if (render.url) {
    form.set('video', render.url);
  } else {
    throw new PublishError('Render has neither filePath nor url', { code: 'asset_missing' });
  }

  const res = await httpRequest(ctx, {
    method: 'POST',
    url: `${baseUrl(config)}/api/upload`,
    headers: { Authorization: `Apikey ${config.apiKey}` },
    body: form,
    mapError: aggregatorError,
  });
  const body = asRecord(res.data);
  if (bool(body.success) === false) {
    throw new PublishError(`Upload-Post rejected the upload: ${str(body.message) ?? str(body.error) ?? 'unknown error'}`, { code: 'provider_error', providerPayload: body });
  }
  const requestId = str(body.request_id) ?? str(body.job_id);
  const result = asRecord(asRecord(body.results)[provider]);
  if (Object.keys(result).length > 0) {
    if (bool(result.skipped) === true) {
      throw new PublishError(`${provider} is not connected in the Upload-Post profile "${user}".`, { code: 'aggregator_platform_not_linked', providerPayload: result });
    }
    if (bool(result.success) === false) {
      throw new PublishError(`Upload-Post failed to publish to ${provider}: ${str(result.error) ?? str(result.message) ?? 'unknown error'}`, {
        code: 'publish_failed',
        providerPayload: result,
      });
    }
    const url = str(result.url) ?? str(result.post_url);
    const externalId = requestId ?? str(result.platform_post_id) ?? str(result.post_id) ?? url;
    if (externalId) return { externalId, status: 'published', ...(url ? { url } : {}) };
  }
  if (!requestId) throw new PublishError('Upload-Post returned no request_id', { code: 'provider_error', providerPayload: body });
  return { externalId: requestId, status: 'processing' };
}

async function uploadPostStatus(ctx: PublisherContext, config: AggregatorConfig, provider: Provider, externalId: string): Promise<PostStatus> {
  const res = await httpRequest(ctx, {
    url: `${baseUrl(config)}/api/uploadposts/status`,
    query: { request_id: externalId },
    headers: { Authorization: `Apikey ${config.apiKey}` },
    mapError: (info) => (info.status === 404 ? undefined : aggregatorError(info)),
  }).catch((err: unknown) => {
    if (err instanceof PublishError && err.status === 404) return undefined;
    throw err;
  });
  if (!res) return { status: 'failed', error: 'Upload-Post does not know this request id.' };
  const body = asRecord(res.data);
  const entry = asRecord(asArray(body.results).find((r) => str(asRecord(r).platform) === provider));
  const top = str(body.status);
  const url = str(entry.post_url) ?? str(entry.url);
  if (bool(entry.skipped) === true) return { status: 'failed', error: `${provider} is not connected in the Upload-Post profile.` };
  const entryState = str(entry.status);
  if (bool(entry.success) === false && entryState !== 'retryable' && entryState !== 'queued' && entryState !== 'processing') {
    return { status: 'failed', error: str(entry.error_message) ?? str(entry.error) ?? str(entry.message) ?? 'Upload-Post reported a failure.' };
  }
  if (bool(entry.success) === true && (top === 'completed' || entryState === 'completed' || url !== undefined)) {
    return { status: 'published', ...(url ? { url } : {}) };
  }
  if (top === 'failed' || top === 'not_found') return { status: 'failed', error: str(body.message) ?? `Upload-Post status: ${top}` };
  return { status: 'processing' };
}

async function uploadPostMetrics(ctx: PublisherContext, config: AggregatorConfig, provider: Provider, externalId: string): Promise<PostMetrics> {
  try {
    const res = await httpRequest(ctx, {
      url: `${baseUrl(config)}/api/uploadposts/post-analytics/${encodeURIComponent(externalId)}`,
      headers: { Authorization: `Apikey ${config.apiKey}` },
      mapError: aggregatorError,
    });
    const scoped = asRecord(pick(res.data, 'platforms', provider) ?? pick(res.data, provider) ?? res.data);
    const m = asRecord(scoped.metrics ?? scoped.post_metrics ?? scoped);
    return metricsOf({
      views: num(m.views) ?? num(m.view_count) ?? num(m.plays),
      likes: num(m.likes) ?? num(m.like_count),
      comments: num(m.comments) ?? num(m.comment_count),
      shares: num(m.shares) ?? num(m.share_count),
      saves: num(m.saves) ?? num(m.saved),
      impressions: num(m.impressions) ?? num(m.reach),
      raw: res.data,
    });
  } catch (err) {
    if (err instanceof PublishError && !err.retryable && err.code !== 'aggregator_auth_invalid') {
      return { raw: { unavailable: err.message } };
    }
    throw err;
  }
}

/* -------------------------------- Ayrshare -------------------------------- */

function ayrshareHeaders(config: AggregatorConfig, account?: AccountInfo): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.apiKey}` };
  const profileKey = config.profileKey ?? str(account?.meta.profileKey);
  if (profileKey) headers['Profile-Key'] = profileKey;
  return headers;
}

function ayrshareEntry(body: unknown, provider: Provider): Record<string, unknown> {
  const platform = ayrsharePlatform(provider);
  return asRecord(asArray(asRecord(body).postIds).find((p) => str(asRecord(p).platform) === platform));
}

function ayrshareErrorMessage(body: unknown): string {
  const first = asRecord(asArray(asRecord(body).errors)[0]);
  return str(first.message) ?? str(asRecord(body).message) ?? 'unknown error';
}

function ayrshareOutcome(body: unknown, provider: Provider): { status: PostStatus['status']; url?: string; error?: string } {
  const entry = ayrshareEntry(body, provider);
  const top = str(asRecord(body).status);
  const state = str(entry.status);
  const url = str(entry.postUrl);
  if (state === 'error' || (top === 'error' && Object.keys(entry).length === 0)) {
    return { status: 'failed', error: str(entry.message) ?? ayrshareErrorMessage(body) };
  }
  if (state === 'success' && str(entry.id) !== 'pending') return { status: 'published', ...(url ? { url } : {}) };
  return { status: 'processing', ...(url ? { url } : {}) };
}

async function ayrsharePublish(ctx: PublisherContext, config: AggregatorConfig, provider: Provider, args: PublishArgs): Promise<PublishResult> {
  const { render, meta, account } = args;
  if (!render.url) {
    throw new PublishError('Ayrshare can only publish from a public HTTPS URL; this render is a local file.', { code: 'asset_url_required' });
  }
  const o = meta.options;
  const body: Record<string, unknown> = {
    post: composeCaption(provider, meta),
    platforms: [ayrsharePlatform(provider)],
    mediaUrls: [render.url],
    isVideo: true,
  };
  switch (provider) {
    case 'youtube':
      body.youTubeOptions = compact({
        title: composeTitle('youtube', meta),
        visibility: o.privacyStatus,
        madeForKids: o.madeForKids,
        categoryId: num(o.categoryId),
        notifySubscribers: o.notifySubscribers,
        shorts: true,
      });
      break;
    case 'instagram':
      body.instagramOptions = compact({ reels: true, shareReelsFeed: o.shareToFeed, thumbNailOffset: meta.coverTimestampMs });
      break;
    case 'facebook':
      body.faceBookOptions = compact({ reels: true, title: o.title ?? meta.title });
      break;
    case 'tiktok': {
      const visibility: Record<string, string> = {
        PUBLIC_TO_EVERYONE: 'public',
        MUTUAL_FOLLOW_FRIENDS: 'friends',
        FOLLOWER_OF_CREATOR: 'followers',
        SELF_ONLY: 'private',
      };
      body.tikTokOptions = compact({
        visibility: typeof o.privacyLevel === 'string' ? visibility[o.privacyLevel] : undefined,
        disableComments: o.disableComment,
        disableDuet: o.disableDuet,
        disableStitch: o.disableStitch,
        isBrandedContent: o.brandContentToggle,
        isBrandOrganic: o.brandOrganicToggle,
        isAIGenerated: o.isAigc,
        thumbNailOffset: meta.coverTimestampMs,
      });
      break;
    }
    default:
      break;
  }
  const res = await httpRequest(ctx, {
    url: `${baseUrl(config)}/api/post`,
    headers: ayrshareHeaders(config, account),
    json: body,
    mapError: aggregatorError,
  });
  const id = str(asRecord(res.data).id);
  const outcome = ayrshareOutcome(res.data, provider);
  if (outcome.status === 'failed') {
    throw new PublishError(`Ayrshare failed to publish to ${provider}: ${outcome.error ?? 'unknown error'}`, { code: 'publish_failed', providerPayload: res.data });
  }
  if (!id) throw new PublishError('Ayrshare returned no post id', { code: 'provider_error', providerPayload: res.data });
  return { externalId: id, status: outcome.status === 'published' ? 'published' : 'processing', ...(outcome.url ? { url: outcome.url } : {}) };
}

async function ayrshareStatus(ctx: PublisherContext, config: AggregatorConfig, provider: Provider, account: AccountInfo, externalId: string): Promise<PostStatus> {
  try {
    const res = await httpRequest(ctx, {
      url: `${baseUrl(config)}/api/post/${encodeURIComponent(externalId)}`,
      headers: ayrshareHeaders(config, account),
      mapError: aggregatorError,
    });
    return ayrshareOutcome(res.data, provider);
  } catch (err) {
    // Ayrshare answers 400 / code 221 "History not found." for unknown ids.
    if (err instanceof PublishError && (err.status === 400 || err.status === 404)) return { status: 'failed', error: err.message };
    throw err;
  }
}

async function ayrshareMetrics(ctx: PublisherContext, config: AggregatorConfig, provider: Provider, account: AccountInfo, externalId: string): Promise<PostMetrics> {
  const platform = ayrsharePlatform(provider);
  const res = await httpRequest(ctx, {
    url: `${baseUrl(config)}/api/analytics/post`,
    headers: ayrshareHeaders(config, account),
    json: { id: externalId, platforms: [platform] },
    mapError: aggregatorError,
  });
  const a = asRecord(pick(res.data, platform, 'analytics'));
  const pub = asRecord(a.publicMetrics);
  const retweets = num(pub.retweetCount);
  const quotes = num(pub.quoteCount);
  return metricsOf({
    views: num(a.videoViews) ?? num(a.views) ?? num(a.viewsCount) ?? num(a.mediaView),
    impressions: num(a.impressionCount) ?? num(pub.impressionCount) ?? num(a.reachCount),
    likes: num(a.likeCount) ?? num(a.likes) ?? num(pub.likeCount),
    comments: num(a.commentsCount) ?? num(a.commentCount) ?? num(a.comments) ?? num(pub.replyCount),
    shares: num(a.shareCount) ?? num(a.sharesCount) ?? (retweets !== undefined || quotes !== undefined ? (retweets ?? 0) + (quotes ?? 0) : undefined),
    saves: num(a.savedCount) ?? num(pub.bookmarkCount),
    raw: res.data,
  });
}

/* ------------------------------- Publisher -------------------------------- */

export function createAggregatorPublisher(provider: Provider, config: AggregatorConfig, native: Publisher): Publisher {
  const syntheticAccount = (): AccountInfo => ({
    externalAccountId: `${config.kind}:${config.profileKey ?? 'default'}:${provider}`,
    displayName: `${provider} via ${config.kind === 'ayrshare' ? 'Ayrshare' : 'Upload-Post'}`,
    meta: compact({ aggregator: config.kind, profileKey: config.profileKey, provider }),
  });
  return {
    provider,
    limits: native.limits,

    /** No provider OAuth: bounce straight back to the app callback so the connect flow stays uniform. */
    getAuthUrl(ctx, args) {
      const u = new URL(ctx.config.redirectUri);
      u.searchParams.set('code', 'aggregator');
      u.searchParams.set('state', args.state);
      return u.toString();
    },

    async connect() {
      return { tokens: { accessToken: '', scopes: [] }, accounts: [syntheticAccount()] };
    },

    async refresh(_ctx, tokens) {
      return tokens;
    },

    validate(render, meta, account) {
      const issues = native.validate(render, meta, account);
      if (config.kind === 'ayrshare' && !render.url) {
        issues.push(...validateCommon(provider, render, meta, { requireUrl: true }).filter((i) => i.code === 'asset_url_required'));
      }
      return issues;
    },

    publish(ctx, args) {
      return config.kind === 'ayrshare' ? ayrsharePublish(ctx, config, provider, args) : uploadPostPublish(ctx, config, provider, args);
    },

    getStatus(ctx, { account, externalId }) {
      return config.kind === 'ayrshare'
        ? ayrshareStatus(ctx, config, provider, account, externalId)
        : uploadPostStatus(ctx, config, provider, externalId);
    },

    fetchMetrics(ctx, { account, externalId }) {
      return config.kind === 'ayrshare'
        ? ayrshareMetrics(ctx, config, provider, account, externalId)
        : uploadPostMetrics(ctx, config, provider, externalId);
    },
  };
}
