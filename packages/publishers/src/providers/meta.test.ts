import { afterAll, describe, expect, it } from 'vitest';
import { ensureFreshTokens } from '../oauth';
import { bodyBytes, formBody, makeAccount, makeMeta, makeRender, query, scriptedFetch, tempVideo, testCtx, TOKENS } from '../testing/mock-fetch';
import { facebookPublisher as fb } from './facebook';
import { instagramPublisher as ig } from './instagram';

const G = 'https://graph.facebook.com/v23.0';
const pagesResponse = {
  data: [
    {
      id: 'page1',
      name: 'Klipz Page',
      access_token: 'page-token-1',
      tasks: ['CREATE_CONTENT', 'MANAGE'],
      picture: { data: { url: 'https://img/p.jpg' } },
      instagram_business_account: { id: 'ig1', username: 'klipz.ig', name: 'Klipz IG', profile_picture_url: 'https://img/ig.jpg' },
    },
    { id: 'page2', name: 'No IG Page', access_token: 'page-token-2', tasks: [] },
  ],
  paging: {},
};
const tokenSteps = [
  {
    method: 'POST',
    url: `${G}/oauth/access_token`,
    check: (c: Parameters<typeof formBody>[0]) => expect(formBody(c)).toEqual({ client_id: 'client-id', client_secret: 'client-secret', redirect_uri: 'http://localhost:3000/api/oauth/test/callback', code: 'the-code' }),
    respond: { json: { access_token: 'short-lived', token_type: 'bearer', expires_in: 5000 } },
  },
  {
    method: 'POST',
    url: `${G}/oauth/access_token`,
    check: (c: Parameters<typeof formBody>[0]) => expect(formBody(c)).toMatchObject({ grant_type: 'fb_exchange_token', fb_exchange_token: 'short-lived' }),
    respond: { json: { access_token: 'long-lived', token_type: 'bearer', expires_in: 5184000 } },
  },
  {
    method: 'GET',
    url: `${G}/me/accounts`,
    check: (c: Parameters<typeof formBody>[0]) => {
      expect(c.headers.get('authorization')).toBe('Bearer long-lived');
      expect(query(c).fields).toContain('instagram_business_account');
    },
    respond: { json: pagesResponse },
  },
];

describe('instagram', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());
  const render = makeRender({ filePath: video.filePath });
  const account = makeAccount({ externalAccountId: 'ig1', username: 'klipz.ig', meta: { igUserId: 'ig1', pageId: 'page1' } });
  const quotaStep = {
    method: 'GET',
    url: `${G}/ig1/content_publishing_limit`,
    respond: { json: { data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }] } },
  };

  it('auth url targets the Facebook dialog with publish scopes', () => {
    const url = new URL(ig.getAuthUrl(testCtx(scriptedFetch([]).fetch), { state: 'st' }));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v23.0/dialog/oauth');
    expect(url.searchParams.get('scope')).toContain('instagram_content_publish');
    expect(url.searchParams.get('state')).toBe('st');
    const custom = new URL(ig.getAuthUrl(testCtx(scriptedFetch([]).fetch, { graphVersion: 'v27.0', configId: 'cfg1' }), { state: 'st' }));
    expect(custom.pathname).toBe('/v27.0/dialog/oauth');
    expect(custom.searchParams.get('config_id')).toBe('cfg1');
    expect(custom.searchParams.get('scope')).toBeNull();
  });

  it('connect gets a long-lived token and discovers IG professional accounts', async () => {
    const mock = scriptedFetch(tokenSteps);
    const res = await ig.connect(testCtx(mock.fetch), { code: 'the-code' });
    expect(res.tokens).toMatchObject({ accessToken: 'long-lived', expiresAt: '2027-01-09T20:00:00.000Z' });
    expect(res.accounts).toEqual([
      { externalAccountId: 'ig1', displayName: 'Klipz IG', username: 'klipz.ig', avatarUrl: 'https://img/ig.jpg', meta: { igUserId: 'ig1', pageId: 'page1', pageName: 'Klipz Page' } },
    ]);
    expect(JSON.stringify(res.accounts)).not.toContain('page-token');
    mock.done();
  });

  it('publishes a local file with a resumable upload: limit -> container -> rupload -> poll -> media_publish', async () => {
    const mock = scriptedFetch([
      quotaStep,
      {
        method: 'POST',
        url: `${G}/ig1/media`,
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('Bearer access-1');
          expect(formBody(c)).toEqual({ media_type: 'REELS', upload_type: 'resumable', caption: 'Hello world\n\n#klipz #clips', share_to_feed: 'true', thumb_offset: '2000' });
        },
        respond: { json: { id: 'cont1', uri: 'https://rupload.facebook.com/ig-api-upload/v23.0/cont1' } },
      },
      {
        method: 'POST',
        url: 'https://rupload.facebook.com/ig-api-upload/v23.0/cont1',
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('OAuth access-1');
          expect(c.headers.get('offset')).toBe('0');
          expect(c.headers.get('file_size')).toBe('10');
          expect(bodyBytes(c)).toEqual(video.bytes);
        },
        respond: { json: { success: true } },
      },
      { method: 'GET', url: `${G}/cont1`, check: (c) => expect(query(c).fields).toBe('status_code,status'), respond: { json: { status_code: 'IN_PROGRESS', id: 'cont1' } } },
      { method: 'GET', url: `${G}/cont1`, respond: { json: { status_code: 'FINISHED', id: 'cont1' } } },
      { method: 'POST', url: `${G}/ig1/media_publish`, check: (c) => expect(formBody(c)).toEqual({ creation_id: 'cont1' }), respond: { json: { id: 'media1' } } },
      { method: 'GET', url: `${G}/media1`, respond: { json: { id: 'media1', permalink: 'https://www.instagram.com/reel/abc/' } } },
    ]);
    const result = await ig.publish(testCtx(mock.fetch), { tokens: TOKENS, account, render, meta: makeMeta({ coverTimestampMs: 2000 }) });
    expect(result).toEqual({ externalId: 'media1', status: 'published', url: 'https://www.instagram.com/reel/abc/' });
    mock.done();
  });

  it('uses video_url only for URL-only renders and hands back a container id when still processing', async () => {
    const mock = scriptedFetch([
      quotaStep,
      {
        method: 'POST',
        url: `${G}/ig1/media`,
        check: (c) => {
          const body = formBody(c);
          expect(body.video_url).toBe('https://cdn.klipz.test/r.mp4');
          expect(body.upload_type).toBeUndefined();
        },
        respond: { json: { id: 'cont2' } },
      },
      { method: 'GET', url: `${G}/cont2`, respond: { json: { status_code: 'IN_PROGRESS' } } },
      // later: getStatus finishes the job
      { method: 'GET', url: `${G}/cont2`, respond: { json: { status_code: 'FINISHED' } } },
      { method: 'POST', url: `${G}/ig1/media_publish`, respond: { json: { id: 'media2' } } },
      { method: 'GET', url: `${G}/media2`, respond: { json: { id: 'media2', permalink: 'https://www.instagram.com/reel/def/' } } },
    ]);
    const ctx = testCtx(mock.fetch, { pollMaxAttempts: '1' });
    const result = await ig.publish(ctx, { tokens: TOKENS, account, render: makeRender({ filePath: undefined, url: 'https://cdn.klipz.test/r.mp4' }), meta: makeMeta() });
    expect(result).toEqual({ externalId: 'container:cont2', status: 'processing' });
    const status = await ig.getStatus(ctx, { tokens: TOKENS, account, externalId: result.externalId });
    expect(status).toEqual({ status: 'published', externalId: 'media2', url: 'https://www.instagram.com/reel/def/' });
    mock.done();
  });

  it('fails when the container errors and when the publishing limit is exhausted', async () => {
    const mock = scriptedFetch([
      quotaStep,
      { method: 'POST', url: `${G}/ig1/media`, respond: { json: { id: 'cont3' } } },
      { method: 'POST', url: /rupload\.facebook\.com\/ig-api-upload\/v23\.0\/cont3$/, respond: { json: { success: true } } },
      { method: 'GET', url: `${G}/cont3`, respond: { json: { status_code: 'ERROR', status: 'Error: 2207026 unsupported video format' } } },
      { method: 'GET', url: `${G}/ig1/content_publishing_limit`, respond: { json: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } } },
    ]);
    const ctx = testCtx(mock.fetch);
    await expect(ig.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta() })).rejects.toMatchObject({ code: 'processing_failed', retryable: false });
    await expect(ig.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta() })).rejects.toMatchObject({ code: 'quota_exceeded', retryable: true });
    mock.done();
  });

  it('refreshes the long-lived token, and ensureFreshTokens triggers it', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: `${G}/oauth/access_token`,
        check: (c) => expect(formBody(c)).toMatchObject({ grant_type: 'fb_exchange_token', fb_exchange_token: 'access-1', client_secret: 'client-secret' }),
        respond: { json: { access_token: 'long-2', expires_in: 5184000 } },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    const out = await ensureFreshTokens(ig, ctx, { accessToken: 'access-1', scopes: ['instagram_basic'], expiresAt: '2026-11-10T20:02:00.000Z' });
    expect(out.refreshed).toBe(true);
    expect(out.tokens).toMatchObject({ accessToken: 'long-2', scopes: ['instagram_basic'] });
    mock.done();
    await expect(ig.refresh(ctx, { accessToken: 'old', scopes: [], expiresAt: '2026-11-01T00:00:00.000Z' })).rejects.toMatchObject({ needsReconnect: true });
  });

  it('maps Graph errors: 190 -> reconnect, code 4 / transient -> retryable', async () => {
    const mock = scriptedFetch([
      { url: `${G}/ig1/content_publishing_limit`, respond: { status: 400, json: { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 } } } },
      { url: `${G}/ig1/content_publishing_limit`, respond: { status: 400, json: { error: { message: 'Application request limit reached', type: 'OAuthException', code: 4 } } } },
      { url: `${G}/ig1/content_publishing_limit`, respond: { status: 500, json: { error: { message: 'An unknown error occurred', code: 1, is_transient: true } } } },
      { url: `${G}/ig1/content_publishing_limit`, respond: { status: 400, json: { error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10 } } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const run = (): Promise<unknown> => ig.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta() });
    await expect(run()).rejects.toMatchObject({ code: 'auth_invalid', needsReconnect: true, retryable: false });
    await expect(run()).rejects.toMatchObject({ code: 'rate_limited', retryable: true, needsReconnect: false });
    await expect(run()).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    await expect(run()).rejects.toMatchObject({ code: 'permission_denied', needsReconnect: true });
    mock.done();
  });

  it('validates caption, hashtags, duration and warns over 90s', () => {
    const v = (r = render, m = makeMeta()): ReturnType<typeof ig.validate> => ig.validate(r, m);
    expect(v().filter((i) => i.severity === 'error')).toEqual([]);
    expect(v(render, makeMeta({ caption: 'c'.repeat(2300) })).map((i) => i.code)).toContain('caption_too_long');
    expect(v(render, makeMeta({ hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) })).map((i) => i.code)).toContain('too_many_hashtags');
    expect(v(makeRender({ durationSec: 901 })).map((i) => i.code)).toContain('duration_too_long');
    expect(v(makeRender({ sizeBytes: 301 * 1024 * 1024 })).map((i) => i.code)).toContain('file_too_large');
    expect(v(makeRender({ durationSec: 120 }))).toContainEqual(expect.objectContaining({ code: 'duration_not_recommended', severity: 'warning' }));
    expect(v(makeRender({ width: 1920, height: 1080 }))).toContainEqual(expect.objectContaining({ code: 'aspect_not_vertical', severity: 'warning' }));
    expect(v(makeRender({ videoCodec: 'vp9' })).map((i) => i.code)).toContain('unsupported_video_codec');
  });

  it('parses status for a published media id and metrics from insights', async () => {
    const mock = scriptedFetch([
      { method: 'GET', url: `${G}/media1`, respond: { json: { id: 'media1', permalink: 'https://www.instagram.com/reel/abc/' } } },
      {
        method: 'GET',
        url: `${G}/media1/insights`,
        check: (c) => {
          expect(query(c).metric).toContain('views');
          expect(query(c).metric).not.toContain('plays');
        },
        respond: {
          json: {
            data: [
              { name: 'views', values: [{ value: 5000 }] },
              { name: 'reach', values: [{ value: 4000 }] },
              { name: 'likes', values: [{ value: 300 }] },
              { name: 'comments', values: [{ value: 20 }] },
              { name: 'shares', values: [{ value: 10 }] },
              { name: 'saved', values: [{ value: 5 }] },
              { name: 'ig_reels_video_view_total_time', values: [{ value: 123456 }] },
            ],
          },
        },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    expect(await ig.getStatus(ctx, { tokens: TOKENS, account, externalId: 'media1' })).toEqual({ status: 'published', url: 'https://www.instagram.com/reel/abc/' });
    expect(await ig.fetchMetrics(ctx, { tokens: TOKENS, account, externalId: 'media1' })).toMatchObject({
      views: 5000,
      impressions: 4000,
      likes: 300,
      comments: 20,
      shares: 10,
      saves: 5,
      watchTimeSec: 123,
    });
    mock.done();
  });
});

describe('facebook', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());
  const render = makeRender({ filePath: video.filePath });
  const account = makeAccount({ externalAccountId: 'page1', meta: { pageId: 'page1' } });
  const pageTokens = { accessToken: 'page-token-1', scopes: [] };
  const RUPLOAD = 'https://rupload.facebook.com/video-upload/v23.0/vid1';

  it('connect returns pages with page tokens only in accountTokens', async () => {
    const mock = scriptedFetch(tokenSteps);
    const res = await fb.connect(testCtx(mock.fetch), { code: 'the-code' });
    expect(res.accounts.map((a) => a.externalAccountId)).toEqual(['page1', 'page2']);
    expect(res.accounts[0]).toMatchObject({ displayName: 'Klipz Page', avatarUrl: 'https://img/p.jpg', meta: { pageId: 'page1' } });
    expect(res.accountTokens?.page1).toMatchObject({ accessToken: 'page-token-1' });
    expect(JSON.stringify(res.accounts)).not.toContain('page-token');
    expect(new URL(fb.getAuthUrl(testCtx(mock.fetch), { state: 's' })).searchParams.get('scope')).toContain('pages_manage_posts');
    mock.done();
  });

  it('publishes a local file: start -> binary rupload -> finish -> status', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: `${G}/page1/video_reels`,
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('Bearer page-token-1');
          expect(formBody(c)).toEqual({ upload_phase: 'start' });
        },
        respond: { json: { video_id: 'vid1', upload_url: RUPLOAD } },
      },
      {
        method: 'POST',
        url: RUPLOAD,
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('OAuth page-token-1');
          expect(c.headers.get('offset')).toBe('0');
          expect(c.headers.get('file_size')).toBe('10');
          expect(c.headers.get('file_url')).toBeNull();
          expect(bodyBytes(c)).toEqual(video.bytes);
        },
        respond: { json: { success: true } },
      },
      {
        method: 'POST',
        url: `${G}/page1/video_reels`,
        check: (c) => expect(formBody(c)).toEqual({ video_id: 'vid1', upload_phase: 'finish', video_state: 'PUBLISHED', description: 'Hello world\n\n#klipz #clips', title: 'Reel title' }),
        respond: { json: { success: true } },
      },
      {
        method: 'GET',
        url: `${G}/vid1`,
        check: (c) => expect(query(c).fields).toBe('status'),
        respond: { json: { status: { video_status: 'processing', uploading_phase: { status: 'complete' }, processing_phase: { status: 'in_progress' }, publishing_phase: { status: 'not_started' } } } },
      },
      { method: 'GET', url: `${G}/vid1`, respond: { json: { status: { video_status: 'ready', processing_phase: { status: 'complete' }, publishing_phase: { status: 'complete', publish_status: 'published' } } } } },
    ]);
    const result = await fb.publish(testCtx(mock.fetch), { tokens: pageTokens, account, render, meta: makeMeta({ title: 'Reel title' }) });
    expect(result).toEqual({ externalId: 'vid1', status: 'published', url: 'https://www.facebook.com/reel/vid1' });
    mock.done();
  });

  it('uses the file_url header for URL-only renders and returns processing at the poll cap', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: `${G}/page1/video_reels`, respond: { json: { video_id: 'vid1' } } },
      {
        method: 'POST',
        url: RUPLOAD, // constructed from the graph version when upload_url is absent
        check: (c) => {
          expect(c.headers.get('file_url')).toBe('https://cdn.klipz.test/r.mp4');
          expect(c.body).toBeUndefined();
        },
        respond: { json: { success: true } },
      },
      { method: 'POST', url: `${G}/page1/video_reels`, respond: { json: { success: true } } },
      { method: 'GET', url: `${G}/vid1`, respond: { json: { status: { video_status: 'processing' } } } },
    ]);
    const result = await fb.publish(testCtx(mock.fetch, { pollMaxAttempts: '1' }), {
      tokens: pageTokens,
      account,
      render: makeRender({ filePath: undefined, url: 'https://cdn.klipz.test/r.mp4' }),
      meta: makeMeta(),
    });
    expect(result).toEqual({ externalId: 'vid1', status: 'processing', url: 'https://www.facebook.com/reel/vid1' });
    mock.done();
  });

  it('maps an expired page token to needsReconnect and a rate limit to retryable', async () => {
    const mock = scriptedFetch([
      { url: `${G}/page1/video_reels`, respond: { status: 400, json: { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } } } },
      { url: `${G}/page1/video_reels`, respond: { status: 400, json: { error: { message: '(#32) Page request limit reached', type: 'OAuthException', code: 32 } } } },
    ]);
    const ctx = testCtx(mock.fetch);
    await expect(fb.publish(ctx, { tokens: pageTokens, account, render, meta: makeMeta() })).rejects.toMatchObject({ code: 'auth_invalid', needsReconnect: true });
    await expect(fb.publish(ctx, { tokens: pageTokens, account, render, meta: makeMeta() })).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    mock.done();
  });

  it('refreshes the user token', async () => {
    const mock = scriptedFetch([{ method: 'POST', url: `${G}/oauth/access_token`, respond: { json: { access_token: 'long-3', expires_in: 5184000 } } }]);
    expect(await fb.refresh(testCtx(mock.fetch), TOKENS)).toMatchObject({ accessToken: 'long-3', expiresAt: '2027-01-09T20:00:00.000Z' });
    mock.done();
  });

  it('validates 3-90s, 9:16, resolution and caption', () => {
    const codes = (r = render, m = makeMeta()): string[] => fb.validate(r, m).filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes()).toEqual([]);
    expect(codes(makeRender({ durationSec: 91 }))).toContain('duration_too_long');
    expect(codes(makeRender({ durationSec: 2 }))).toContain('duration_too_short');
    expect(codes(makeRender({ width: 1080, height: 1080 }))).toContain('aspect_ratio_unsupported');
    expect(codes(makeRender({ width: 360, height: 640 }))).toContain('resolution_too_low');
    expect(codes(makeRender({ fps: 20 }))).toContain('fps_unsupported');
    expect(codes(render, makeMeta({ caption: 'c'.repeat(5001) }))).toContain('caption_too_long');
  });

  it('parses failed status and video insights', async () => {
    const mock = scriptedFetch([
      { method: 'GET', url: `${G}/vid1`, respond: { json: { status: { video_status: 'error', processing_phase: { status: 'error', error: { message: 'Video is too short' } } } } } },
      {
        method: 'GET',
        url: `${G}/vid1/video_insights`,
        check: (c) => expect(c.headers.get('authorization')).toBe('Bearer page-token-1'),
        respond: {
          json: {
            data: [
              { name: 'blue_reels_play_count', values: [{ value: 900 }] },
              { name: 'post_impressions_unique', values: [{ value: 700 }] },
              { name: 'post_video_view_time', values: [{ value: 60000 }] },
              { name: 'post_video_likes_by_reaction_type', values: [{ value: { REACTION_LIKE: 40, REACTION_LOVE: 2 } }] },
              { name: 'post_video_social_actions', values: [{ value: { COMMENT: 3, SHARE: 4 } }] },
            ],
          },
        },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    expect(await fb.getStatus(ctx, { tokens: pageTokens, account, externalId: 'vid1' })).toEqual({ status: 'failed', error: 'Facebook Reel failed (error): Video is too short' });
    expect(await fb.fetchMetrics(ctx, { tokens: pageTokens, account, externalId: 'vid1' })).toMatchObject({ views: 900, impressions: 700, likes: 42, comments: 3, shares: 4, watchTimeSec: 60 });
    mock.done();
  });
});
