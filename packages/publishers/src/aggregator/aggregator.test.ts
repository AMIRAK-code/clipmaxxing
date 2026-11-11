import { afterAll, describe, expect, it } from 'vitest';
import { aggregatorConfigFromEnv, getPublisher } from '../registry';
import { jsonBody, makeAccount, makeMeta, makeRender, query, scriptedFetch, tempVideo, testCtx, TOKENS } from '../testing/mock-fetch';
import type { AggregatorConfig } from '../types';
import { tiktokPublisher } from '../providers/tiktok';
import { youtubePublisher } from '../providers/youtube';

const uploadPost: AggregatorConfig = { kind: 'upload-post', apiKey: 'up-key', providers: ['tiktok', 'instagram'], profileKey: 'me' };
const ayrshare: AggregatorConfig = { kind: 'ayrshare', apiKey: 'ayr-key', providers: ['youtube', 'x'], profileKey: 'profile-key' };
const tiktokOptions = { privacyLevel: 'SELF_ONLY', consentAccepted: true };

describe('aggregator routing', () => {
  it('routes only the configured providers', () => {
    expect(getPublisher('youtube', { aggregator: uploadPost })).toBe(youtubePublisher);
    expect(getPublisher('tiktok')).toBe(tiktokPublisher);
    const routed = getPublisher('tiktok', { aggregator: uploadPost });
    expect(routed).not.toBe(tiktokPublisher);
    expect(routed.provider).toBe('tiktok');
    expect(routed.limits).toBe(tiktokPublisher.limits);
    expect(getPublisher('tiktok', { aggregator: { ...uploadPost, apiKey: '' } })).toBe(tiktokPublisher);
  });

  it('builds the config from env values', () => {
    expect(aggregatorConfigFromEnv({ AGGREGATOR_KIND: 'ayrshare', AGGREGATOR_API_KEY: 'k', AGGREGATOR_PROVIDERS: 'tiktok, X bogus' })).toEqual({ kind: 'ayrshare', apiKey: 'k', providers: ['tiktok', 'x'] });
    expect(aggregatorConfigFromEnv({ AGGREGATOR_KIND: 'other', AGGREGATOR_API_KEY: 'k' })).toBeUndefined();
    expect(aggregatorConfigFromEnv({})).toBeUndefined();
  });

  it('connect returns a synthetic account without touching the network', async () => {
    const mock = scriptedFetch([]);
    const pub = getPublisher('tiktok', { aggregator: uploadPost });
    const ctx = testCtx(mock.fetch);
    const authUrl = new URL(pub.getAuthUrl(ctx, { state: 'signed-state' }));
    expect(authUrl.origin + authUrl.pathname).toBe('http://localhost:3000/api/oauth/test/callback');
    expect(authUrl.searchParams.get('state')).toBe('signed-state');
    const res = await pub.connect(ctx, { code: 'aggregator' });
    expect(res.accounts).toEqual([{ externalAccountId: 'upload-post:me:tiktok', displayName: 'tiktok via Upload-Post', meta: { aggregator: 'upload-post', profileKey: 'me', provider: 'tiktok' } }]);
    expect(JSON.stringify(res)).not.toContain('up-key');
    expect(await pub.refresh(ctx, TOKENS)).toBe(TOKENS);
    expect(mock.calls).toHaveLength(0);
  });

  it('validate reuses the native validator', () => {
    const pub = getPublisher('tiktok', { aggregator: uploadPost });
    expect(pub.validate(makeRender(), makeMeta()).map((i) => i.code)).toEqual(expect.arrayContaining(['privacy_required', 'consent_required']));
    expect(pub.validate(makeRender(), makeMeta({ options: tiktokOptions })).filter((i) => i.severity === 'error')).toEqual([]);
    const ayr = getPublisher('youtube', { aggregator: ayrshare });
    expect(ayr.validate(makeRender(), makeMeta()).map((i) => i.code)).toContain('asset_url_required');
    expect(ayr.validate(makeRender({ url: 'https://cdn.klipz.test/r.mp4' }), makeMeta()).filter((i) => i.severity === 'error')).toEqual([]);
  });
});

describe('upload-post', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());
  const pub = getPublisher('tiktok', { aggregator: uploadPost });
  const account = makeAccount();

  it('publishes a local file as multipart and polls status / analytics', async () => {
    let fileBytes: Promise<number[]> | undefined;
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: 'https://api.upload-post.com/api/upload',
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('Apikey up-key');
          const form = c.body as FormData;
          expect(form.get('user')).toBe('me');
          expect(form.getAll('platform[]')).toEqual(['tiktok']);
          expect(form.get('title')).toBe('Hello world\n\n#klipz #clips');
          expect(form.get('async_upload')).toBe('true');
          expect(form.get('privacy_level')).toBe('SELF_ONLY');
          fileBytes = (form.get('video') as Blob).arrayBuffer().then((b) => Array.from(new Uint8Array(b)));
        },
        respond: { json: { success: true, message: 'Upload initiated', request_id: 'req-1', total_platforms: 1 } },
      },
      {
        method: 'GET',
        url: 'https://api.upload-post.com/api/uploadposts/status',
        check: (c) => expect(query(c)).toEqual({ request_id: 'req-1' }),
        respond: { json: { request_id: 'req-1', status: 'in_progress', completed: 0, total: 1, results: [] } },
      },
      {
        method: 'GET',
        url: 'https://api.upload-post.com/api/uploadposts/status',
        respond: { json: { request_id: 'req-1', status: 'completed', completed: 1, total: 1, results: [{ platform: 'tiktok', success: true, post_url: 'https://www.tiktok.com/@me/video/1', platform_post_id: '1' }] } },
      },
      {
        method: 'GET',
        url: 'https://api.upload-post.com/api/uploadposts/status',
        respond: { json: { request_id: 'req-1', status: 'failed', completed: 1, total: 1, results: [{ platform: 'tiktok', success: false, error_message: 'Video rejected' }] } },
      },
      { method: 'GET', url: 'https://api.upload-post.com/api/uploadposts/post-analytics/req-1', respond: { json: { platforms: { tiktok: { metrics: { views: 10, likes: 2, comments: 1, shares: 0 } } } } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const result = await pub.publish(ctx, { tokens: TOKENS, account, render: makeRender({ filePath: video.filePath }), meta: makeMeta({ options: tiktokOptions }) });
    expect(result).toEqual({ externalId: 'req-1', status: 'processing' });
    expect(await fileBytes).toEqual(video.bytes);
    const args = { tokens: TOKENS, account, externalId: 'req-1' };
    expect(await pub.getStatus(ctx, args)).toEqual({ status: 'processing' });
    expect(await pub.getStatus(ctx, args)).toEqual({ status: 'published', url: 'https://www.tiktok.com/@me/video/1' });
    expect(await pub.getStatus(ctx, args)).toEqual({ status: 'failed', error: 'Video rejected' });
    expect(await pub.fetchMetrics(ctx, args)).toMatchObject({ views: 10, likes: 2, comments: 1, shares: 0 });
    mock.done();
  });

  it('sends the URL when there is no local file and maps key / rate errors', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: 'https://api.upload-post.com/api/upload', check: (c) => expect((c.body as FormData).get('video')).toBe('https://cdn.klipz.test/r.mp4'), respond: { status: 401, json: { success: false, message: 'Invalid API key' } } },
      { method: 'POST', url: 'https://api.upload-post.com/api/upload', respond: { status: 429, json: { success: false, message: 'Monthly limit reached' } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const run = (): Promise<unknown> =>
      pub.publish(ctx, { tokens: TOKENS, account, render: makeRender({ filePath: undefined, url: 'https://cdn.klipz.test/r.mp4' }), meta: makeMeta({ options: tiktokOptions }) });
    await expect(run()).rejects.toMatchObject({ code: 'aggregator_auth_invalid', needsReconnect: false, retryable: false });
    await expect(run()).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    mock.done();
  });
});

describe('ayrshare', () => {
  const pub = getPublisher('youtube', { aggregator: ayrshare });
  const account = makeAccount();
  const render = makeRender({ filePath: undefined, url: 'https://cdn.klipz.test/r.mp4' });

  it('publishes from a URL, then reads status and analytics', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: 'https://api.ayrshare.com/api/post',
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('Bearer ayr-key');
          expect(c.headers.get('profile-key')).toBe('profile-key');
          expect(jsonBody(c)).toEqual({
            post: 'Hello world\n\n#klipz #clips #Shorts',
            platforms: ['youtube'],
            mediaUrls: ['https://cdn.klipz.test/r.mp4'],
            isVideo: true,
            youTubeOptions: { title: 'Hello world', visibility: 'unlisted', shorts: true },
          });
        },
        respond: { json: { status: 'success', errors: [], postIds: [{ status: 'success', id: 'yt-1', postUrl: 'https://youtu.be/yt-1', platform: 'youtube' }], id: 'ayr-1' } },
      },
      { method: 'GET', url: 'https://api.ayrshare.com/api/post/ayr-1', respond: { json: { id: 'ayr-1', status: 'success', postIds: [{ status: 'success', id: 'yt-1', postUrl: 'https://youtu.be/yt-1', platform: 'youtube' }] } } },
      { method: 'GET', url: 'https://api.ayrshare.com/api/post/ayr-1', respond: { status: 400, json: { action: 'history', status: 'error', code: 221, message: 'History not found.' } } },
      {
        method: 'POST',
        url: 'https://api.ayrshare.com/api/analytics/post',
        check: (c) => expect(jsonBody(c)).toEqual({ id: 'ayr-1', platforms: ['youtube'] }),
        respond: { json: { status: 'success', code: 200, id: 'ayr-1', youtube: { id: 'yt-1', postUrl: 'https://youtu.be/yt-1', analytics: { views: 321, likes: 12, comments: 3 } } } },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    const result = await pub.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta({ options: { privacyStatus: 'unlisted' } }) });
    expect(result).toEqual({ externalId: 'ayr-1', status: 'published', url: 'https://youtu.be/yt-1' });
    const args = { tokens: TOKENS, account, externalId: 'ayr-1' };
    expect(await pub.getStatus(ctx, args)).toEqual({ status: 'published', url: 'https://youtu.be/yt-1' });
    expect((await pub.getStatus(ctx, args)).status).toBe('failed');
    expect(await pub.fetchMetrics(ctx, args)).toMatchObject({ views: 321, likes: 12, comments: 3 });
    mock.done();
  });

  it('maps x to twitter, treats pending ids as processing and refuses local-only renders', async () => {
    const xPub = getPublisher('x', { aggregator: ayrshare });
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: 'https://api.ayrshare.com/api/post',
        check: (c) => expect(jsonBody(c).platforms).toEqual(['twitter']),
        respond: { json: { status: 'success', errors: [], postIds: [{ status: 'success', id: 'pending', platform: 'twitter' }], id: 'ayr-2' } },
      },
      {
        method: 'POST',
        url: 'https://api.ayrshare.com/api/post',
        respond: { status: 400, json: { status: 'error', errors: [{ action: 'post', status: 'error', code: 156, message: 'Twitter is not linked.', platform: 'twitter' }], postIds: [], id: 'ayr-3' } },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    expect(await xPub.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta() })).toEqual({ externalId: 'ayr-2', status: 'processing' });
    await expect(xPub.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta() })).rejects.toMatchObject({ code: 'provider_error' });
    await expect(xPub.publish(ctx, { tokens: TOKENS, account, render: makeRender(), meta: makeMeta() })).rejects.toMatchObject({ code: 'asset_url_required' });
    mock.done();
  });
});
