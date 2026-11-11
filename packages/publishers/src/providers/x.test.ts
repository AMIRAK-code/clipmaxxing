import { afterAll, describe, expect, it } from 'vitest';
import { PublishError } from '../errors';
import { formBody, jsonBody, makeAccount, makeMeta, makeRender, query, scriptedFetch, tempVideo, testCtx, TOKENS, type RecordedCall } from '../testing/mock-fetch';
import { xPublisher as x } from './x';

const API = 'https://api.x.com/2';
const BASIC = `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`;

async function segment(call: RecordedCall): Promise<{ index: string; bytes: number[] }> {
  const form = call.body as FormData;
  const media = form.get('media') as Blob;
  return { index: String(form.get('segment_index')), bytes: Array.from(new Uint8Array(await media.arrayBuffer())) };
}

describe('x', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());
  const render = makeRender({ filePath: video.filePath });
  const account = makeAccount({ externalAccountId: '42', username: 'klipz' });

  it('requires PKCE and builds the authorize url', () => {
    const ctx = testCtx(scriptedFetch([]).fetch);
    expect(() => x.getAuthUrl(ctx, { state: 's' })).toThrow(PublishError);
    const url = new URL(x.getAuthUrl(ctx, { state: 's', codeChallenge: 'cc' }));
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('scope')).toBe('tweet.read tweet.write users.read media.write offline.access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('connect exchanges the code with basic auth and loads the profile', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: `${API}/oauth2/token`,
        check: (c) => {
          expect(c.headers.get('authorization')).toBe(BASIC);
          expect(formBody(c)).toMatchObject({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v', redirect_uri: 'http://localhost:3000/api/oauth/test/callback' });
        },
        respond: { json: { token_type: 'bearer', access_token: 'xat', refresh_token: 'xrt', expires_in: 7200, scope: 'tweet.read tweet.write users.read media.write offline.access' } },
      },
      { method: 'GET', url: `${API}/users/me`, respond: { json: { data: { id: '42', name: 'Klipz', username: 'klipz', profile_image_url: 'https://img/x.jpg' } } } },
    ]);
    const res = await x.connect(testCtx(mock.fetch), { code: 'c', codeVerifier: 'v' });
    expect(res.tokens).toMatchObject({ accessToken: 'xat', refreshToken: 'xrt', expiresAt: '2026-11-10T22:00:00.000Z' });
    expect(res.accounts).toEqual([{ externalAccountId: '42', displayName: 'Klipz', username: 'klipz', avatarUrl: 'https://img/x.jpg', meta: { userId: '42' } }]);
    mock.done();
  });

  it('publishes: initialize -> append segments -> finalize -> STATUS -> create post', async () => {
    const segments: Array<Promise<{ index: string; bytes: number[] }>> = [];
    const append = { method: 'POST', url: `${API}/media/upload/m1/append`, check: (c: RecordedCall) => void segments.push(segment(c)), respond: { json: { data: { expires_at: 1 } } } };
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: `${API}/media/upload/initialize`,
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('Bearer access-1');
          expect(jsonBody(c)).toEqual({ media_type: 'video/mp4', total_bytes: 10, media_category: 'tweet_video' });
        },
        respond: { json: { data: { id: 'm1', media_key: '7_m1', expires_after_secs: 86400 } } },
      },
      append,
      append,
      append,
      { method: 'POST', url: `${API}/media/upload/m1/finalize`, respond: { json: { data: { id: 'm1', processing_info: { state: 'pending', check_after_secs: 2 } } } } },
      { method: 'GET', url: `${API}/media/upload`, check: (c) => expect(query(c)).toEqual({ command: 'STATUS', media_id: 'm1' }), respond: { json: { data: { id: 'm1', processing_info: { state: 'in_progress', check_after_secs: 3, progress_percent: 50 } } } } },
      { method: 'GET', url: `${API}/media/upload`, respond: { json: { data: { id: 'm1', processing_info: { state: 'succeeded', progress_percent: 100 } } } } },
      {
        method: 'POST',
        url: `${API}/tweets`,
        check: (c) => expect(jsonBody(c)).toEqual({ text: 'Hello world #klipz #clips', media: { media_ids: ['m1'] } }),
        respond: { status: 201, json: { data: { id: '1900', text: 'Hello world #klipz #clips' } } },
      },
    ]);
    const ctx = testCtx(mock.fetch, { chunkSizeBytes: '4' });
    const result = await x.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta() });
    expect(result).toEqual({ externalId: '1900', status: 'published', url: 'https://x.com/klipz/status/1900' });
    expect(await Promise.all(segments)).toEqual([
      { index: '0', bytes: [0, 1, 2, 3] },
      { index: '1', bytes: [4, 5, 6, 7] },
      { index: '2', bytes: [8, 9] },
    ]);
    expect(ctx.sleeps).toEqual([2000, 3000]); // honours check_after_secs
    mock.done();
  });

  it('uses amplify_video for long videos and fails when processing fails', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: `${API}/media/upload/initialize`, check: (c) => expect(jsonBody(c).media_category).toBe('amplify_video'), respond: { json: { data: { id: 'm2' } } } },
      { method: 'POST', url: `${API}/media/upload/m2/append`, respond: { json: {} } },
      { method: 'POST', url: `${API}/media/upload/m2/finalize`, respond: { json: { data: { id: 'm2', processing_info: { state: 'pending', check_after_secs: 1 } } } } },
      { method: 'GET', url: `${API}/media/upload`, respond: { json: { data: { id: 'm2', processing_info: { state: 'failed', error: { code: 1, name: 'InvalidMedia', message: 'Unsupported codec' } } } } } },
    ]);
    await expect(
      x.publish(testCtx(mock.fetch), { tokens: TOKENS, account, render: makeRender({ filePath: video.filePath, durationSec: 200 }), meta: makeMeta({ options: { longVideo: true } }) }),
    ).rejects.toMatchObject({ code: 'processing_failed', message: expect.stringContaining('Unsupported codec') });
    mock.done();
  });

  it('refreshes with rotation and maps a dead refresh token to needsReconnect', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: `${API}/oauth2/token`,
        check: (c) => {
          expect(c.headers.get('authorization')).toBe(BASIC);
          expect(formBody(c)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-id' });
        },
        respond: { json: { access_token: 'xat2', refresh_token: 'xrt2', expires_in: 7200, scope: 'tweet.read tweet.write' } },
      },
      { method: 'POST', url: `${API}/oauth2/token`, respond: { status: 400, json: { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' } } },
    ]);
    const ctx = testCtx(mock.fetch);
    expect(await x.refresh(ctx, TOKENS)).toMatchObject({ accessToken: 'xat2', refreshToken: 'xrt2', scopes: ['tweet.read', 'tweet.write'] });
    await expect(x.refresh(ctx, TOKENS)).rejects.toMatchObject({ code: 'auth_invalid', needsReconnect: true });
    mock.done();
  });

  it('maps 429 with x-rate-limit-reset, 401 and free-tier 403', async () => {
    const reset = Math.floor(new Date('2026-11-10T20:05:00Z').getTime() / 1000);
    const mock = scriptedFetch([
      { method: 'POST', url: `${API}/media/upload/initialize`, respond: { status: 429, headers: { 'x-rate-limit-reset': String(reset) }, json: { title: 'Too Many Requests', detail: 'Too Many Requests', status: 429 } } },
      { method: 'POST', url: `${API}/media/upload/initialize`, respond: { status: 401, json: { title: 'Unauthorized', detail: 'Unauthorized', status: 401 } } },
      {
        method: 'POST',
        url: `${API}/media/upload/initialize`,
        respond: {
          status: 403,
          json: { title: 'Client Forbidden', detail: 'When authenticating requests to the Twitter API v2 endpoints, you must use keys and tokens from a Twitter developer App that is attached to a Project.', reason: 'client-not-enrolled', type: 'https://api.twitter.com/2/problems/client-forbidden' },
        },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    const run = (): Promise<unknown> => x.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta() });
    await expect(run()).rejects.toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSec: 300 });
    await expect(run()).rejects.toMatchObject({ code: 'auth_invalid', needsReconnect: true });
    await expect(run()).rejects.toMatchObject({ code: 'tier_required', retryable: false, needsReconnect: false });
    mock.done();
  });

  it('validates the 280 weighted limit, duration and aspect', () => {
    const codes = (r = render, m = makeMeta()): string[] => x.validate(r, m).filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes()).toEqual([]);
    expect(codes(render, makeMeta({ caption: 'a'.repeat(281), hashtags: [] }))).toContain('caption_too_long');
    expect(codes(render, makeMeta({ caption: '日'.repeat(141), hashtags: [] }))).toContain('caption_too_long'); // CJK weighs 2
    expect(codes(render, makeMeta({ caption: `${'a'.repeat(250)} https://example.com/${'p'.repeat(200)}`, hashtags: [] }))).toEqual([]); // URL = 23
    expect(codes(makeRender({ durationSec: 141 }))).toContain('duration_too_long');
    expect(codes(makeRender({ durationSec: 141 }), makeMeta({ options: { longVideo: true } }))).toEqual([]);
    expect(codes(makeRender({ width: 400, height: 1920 }))).toContain('aspect_ratio_unsupported');
    expect(codes(makeRender({ sizeBytes: 600 * 1024 * 1024 }))).toContain('file_too_large');
  });

  it('parses status and metrics', async () => {
    const mock = scriptedFetch([
      { method: 'GET', url: `${API}/tweets/1900`, respond: { json: { data: { id: '1900', text: 'hi' } } } },
      { method: 'GET', url: `${API}/tweets/1900`, respond: { status: 404, json: { title: 'Not Found Error', detail: 'Could not find tweet' } } },
      {
        method: 'GET',
        url: `${API}/tweets/1900`,
        check: (c) => expect(query(c)['tweet.fields']).toBe('public_metrics,organic_metrics'),
        respond: {
          json: {
            data: { id: '1900', public_metrics: { retweet_count: 3, reply_count: 4, like_count: 50, quote_count: 2, bookmark_count: 6, impression_count: 2000 } },
            includes: { media: [{ media_key: '7_m1', type: 'video', public_metrics: { view_count: 800 } }] },
          },
        },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    const args = { tokens: TOKENS, account, externalId: '1900' };
    expect(await x.getStatus(ctx, args)).toEqual({ status: 'published', url: 'https://x.com/klipz/status/1900' });
    expect((await x.getStatus(ctx, args)).status).toBe('failed');
    expect(await x.fetchMetrics(ctx, args)).toMatchObject({ views: 800, impressions: 2000, likes: 50, comments: 4, shares: 5, saves: 6 });
    mock.done();
  });
});
