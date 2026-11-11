import { afterAll, describe, expect, it } from 'vitest';
import { PublishError } from '../errors';
import { bodyBytes, formBody, jsonBody, makeAccount, makeMeta, makeRender, query, scriptedFetch, tempVideo, testCtx, TOKENS } from '../testing/mock-fetch';
import { secondsUntilPacificMidnight, youtubePublisher as yt } from './youtube';

const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const SESSION = 'https://upload.test/session/abc';

describe('youtube', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());
  const render = makeRender({ filePath: video.filePath });

  it('builds an offline-access auth url', () => {
    const url = new URL(yt.getAuthUrl(testCtx(scriptedFetch([]).fetch), { state: 'st', codeChallenge: 'cc' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('youtube.upload');
    expect(url.searchParams.get('scope')).toContain('yt-analytics.readonly');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/oauth/test/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('connect exchanges the code and lists channels', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        check: (c) => expect(formBody(c)).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'client-id', code_verifier: 'ver' }),
        respond: { json: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'a b' } },
      },
      {
        method: 'GET',
        url: 'https://www.googleapis.com/youtube/v3/channels',
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('Bearer at');
          expect(query(c)).toMatchObject({ part: 'snippet', mine: 'true' });
        },
        respond: { json: { items: [{ id: 'UC1', snippet: { title: 'My Channel', customUrl: '@me', thumbnails: { default: { url: 'https://img/x.jpg' } } } }] } },
      },
    ]);
    const res = await yt.connect(testCtx(mock.fetch), { code: 'the-code', codeVerifier: 'ver' });
    expect(res.tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', scopes: ['a', 'b'], expiresAt: '2026-11-10T21:00:00.000Z' });
    expect(res.accounts).toEqual([{ externalAccountId: 'UC1', displayName: 'My Channel', username: '@me', avatarUrl: 'https://img/x.jpg', meta: { channelId: 'UC1' } }]);
    mock.done();
  });

  it('publishes through a resumable upload in chunks', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: UPLOAD,
        check: (c) => {
          expect(query(c)).toMatchObject({ uploadType: 'resumable', part: 'snippet,status', notifySubscribers: 'false' });
          expect(c.headers.get('authorization')).toBe('Bearer access-1');
          expect(c.headers.get('x-upload-content-length')).toBe('10');
          expect(c.headers.get('x-upload-content-type')).toBe('video/mp4');
          const body = jsonBody(c) as { snippet: Record<string, unknown>; status: Record<string, unknown> };
          expect(body.snippet).toMatchObject({ title: 'My title', description: 'Hello world\n\n#klipz #clips #Shorts', categoryId: '24', tags: ['klipz', 'clips'] });
          expect(body.status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: false });
        },
        respond: { headers: { location: SESSION } },
      },
      {
        method: 'PUT',
        url: SESSION,
        check: (c) => {
          expect(c.headers.get('content-range')).toBe('bytes 0-3/10');
          expect(bodyBytes(c)).toEqual([0, 1, 2, 3]);
        },
        respond: { status: 308, headers: { range: 'bytes=0-3' } },
      },
      { method: 'PUT', url: SESSION, check: (c) => expect(c.headers.get('content-range')).toBe('bytes 4-7/10'), respond: { status: 308, headers: { range: 'bytes=0-7' } } },
      {
        method: 'PUT',
        url: SESSION,
        check: (c) => {
          expect(c.headers.get('content-range')).toBe('bytes 8-9/10');
          expect(bodyBytes(c)).toEqual([8, 9]);
        },
        respond: { status: 201, json: { id: 'vid123', status: { uploadStatus: 'uploaded' } } },
      },
    ]);
    const progress: number[] = [];
    const ctx = { ...testCtx(mock.fetch, { chunkSizeBytes: '4' }), onProgress: (p: number) => progress.push(p) };
    const result = await yt.publish(ctx, {
      tokens: TOKENS,
      account: makeAccount(),
      render,
      meta: makeMeta({ title: 'My title', options: { privacyStatus: 'unlisted', categoryId: '24', notifySubscribers: false } }),
    });
    expect(result).toEqual({ externalId: 'vid123', status: 'processing', url: 'https://www.youtube.com/shorts/vid123' });
    expect(progress).toEqual([40, 80, 100]);
    mock.done();
  });

  it('resumes after a 5xx by asking the server for the committed offset', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: UPLOAD, respond: { headers: { location: SESSION } } },
      { method: 'PUT', url: SESSION, check: (c) => expect(c.headers.get('content-range')).toBe('bytes 0-5/10'), respond: { status: 503, text: 'backend error' } },
      { method: 'PUT', url: SESSION, check: (c) => expect(c.headers.get('content-range')).toBe('bytes */10'), respond: { status: 308, headers: { range: 'bytes=0-2' } } },
      {
        method: 'PUT',
        url: SESSION,
        check: (c) => {
          expect(c.headers.get('content-range')).toBe('bytes 3-8/10');
          expect(bodyBytes(c)).toEqual([3, 4, 5, 6, 7, 8]);
        },
        respond: { status: 308, headers: { range: 'bytes=0-8' } },
      },
      { method: 'PUT', url: SESSION, check: (c) => expect(c.headers.get('content-range')).toBe('bytes 9-9/10'), respond: { status: 200, json: { id: 'vid9' } } },
    ]);
    const ctx = testCtx(mock.fetch, { chunkSizeBytes: '6' });
    const result = await yt.publish(ctx, { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta() });
    expect(result.externalId).toBe('vid9');
    expect(ctx.sleeps).toHaveLength(1);
    mock.done();
  });

  it('refreshes tokens and keeps the refresh token', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: 'https://oauth2.googleapis.com/token',
        check: (c) => expect(formBody(c)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-id', client_secret: 'client-secret' }),
        respond: { json: { access_token: 'at2', expires_in: 3599 } },
      },
    ]);
    const next = await yt.refresh(testCtx(mock.fetch), { ...TOKENS, scopes: ['s'] });
    expect(next).toMatchObject({ accessToken: 'at2', refreshToken: 'refresh-1', scopes: ['s'] });
    expect(next.expiresAt).toBe('2026-11-10T20:59:59.000Z');
    mock.done();
  });

  it('maps a revoked refresh token to needsReconnect', async () => {
    const mock = scriptedFetch([{ url: 'https://oauth2.googleapis.com/token', respond: { status: 400, json: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } }]);
    await expect(yt.refresh(testCtx(mock.fetch), TOKENS)).rejects.toMatchObject({ code: 'auth_invalid', needsReconnect: true, retryable: false });
    await expect(yt.refresh(testCtx(mock.fetch), { accessToken: 'a', scopes: [] })).rejects.toMatchObject({ needsReconnect: true });
  });

  it('maps quotaExceeded to a retryable quota error until Pacific midnight', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: UPLOAD,
        respond: { status: 403, json: { error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } } },
      },
    ]);
    let error: unknown;
    try {
      await yt.publish(testCtx(mock.fetch), { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta() });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PublishError);
    // FIXED_NOW = 20:00Z = 12:00 PST -> 12h to midnight
    expect(error).toMatchObject({ code: 'quota_exceeded', retryable: true, needsReconnect: false, retryAfterSec: 12 * 3600 });
    mock.done();
  });

  it('maps 401 on upload init to needsReconnect', async () => {
    const mock = scriptedFetch([{ method: 'POST', url: UPLOAD, respond: { status: 401, json: { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } } } }]);
    await expect(yt.publish(testCtx(mock.fetch), { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta() })).rejects.toMatchObject({
      code: 'auth_invalid',
      needsReconnect: true,
    });
  });

  it('computes seconds to Pacific midnight across DST', () => {
    expect(secondsUntilPacificMidnight(new Date('2026-07-01T06:59:00Z'))).toBe(60); // 23:59 PDT
    expect(secondsUntilPacificMidnight(new Date('2026-12-01T08:00:00Z'))).toBe(86400); // 00:00 PST
  });

  it('validates duration, aspect, caption and title', () => {
    const codes = (issues: ReturnType<typeof yt.validate>): string[] => issues.filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes(yt.validate(render, makeMeta()))).toEqual([]);
    expect(codes(yt.validate(makeRender({ durationSec: 181 }), makeMeta()))).toContain('duration_too_long');
    expect(codes(yt.validate(makeRender({ width: 1920, height: 1080 }), makeMeta()))).toContain('aspect_ratio_unsupported');
    expect(codes(yt.validate(render, makeMeta({ caption: 'x'.repeat(5001) })))).toContain('caption_too_long');
    expect(codes(yt.validate(render, makeMeta({ title: 't'.repeat(101) })))).toContain('title_too_long');
    expect(codes(yt.validate(render, makeMeta({ options: { privacyStatus: 'friends' } })))).toContain('invalid_option');
    expect(codes(yt.validate(makeRender({ fps: 120 }), makeMeta()))).toContain('fps_unsupported');
  });

  it('parses status', async () => {
    const mock = scriptedFetch([
      {
        url: 'https://www.googleapis.com/youtube/v3/videos',
        check: (c) => expect(query(c)).toEqual({ part: 'status,processingDetails', id: 'vid1' }),
        respond: { json: { items: [{ id: 'vid1', status: { uploadStatus: 'uploaded' }, processingDetails: { processingStatus: 'processing' } }] } },
      },
      { url: 'https://www.googleapis.com/youtube/v3/videos', respond: { json: { items: [{ id: 'vid1', status: { uploadStatus: 'processed', privacyStatus: 'public' } }] } } },
      { url: 'https://www.googleapis.com/youtube/v3/videos', respond: { json: { items: [{ id: 'vid1', status: { uploadStatus: 'rejected', rejectionReason: 'duplicate' } }] } } },
      { url: 'https://www.googleapis.com/youtube/v3/videos', respond: { json: { items: [] } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const args = { tokens: TOKENS, account: makeAccount(), externalId: 'vid1' };
    expect(await yt.getStatus(ctx, args)).toEqual({ status: 'processing', url: 'https://www.youtube.com/shorts/vid1' });
    expect(await yt.getStatus(ctx, args)).toEqual({ status: 'published', url: 'https://www.youtube.com/shorts/vid1' });
    expect(await yt.getStatus(ctx, args)).toEqual({ status: 'failed', error: 'Rejected: duplicate' });
    expect((await yt.getStatus(ctx, args)).status).toBe('failed');
    mock.done();
  });

  it('parses metrics', async () => {
    const mock = scriptedFetch([
      {
        url: 'https://www.googleapis.com/youtube/v3/videos',
        check: (c) => expect(query(c)).toEqual({ part: 'statistics', id: 'vid1' }),
        respond: { json: { items: [{ id: 'vid1', statistics: { viewCount: '1234', likeCount: '56', commentCount: '7', favoriteCount: '0' } }] } },
      },
    ]);
    const m = await yt.fetchMetrics(testCtx(mock.fetch), { tokens: TOKENS, account: makeAccount(), externalId: 'vid1' });
    expect(m).toMatchObject({ views: 1234, likes: 56, comments: 7 });
    expect(m.shares).toBeUndefined();
    expect(m.raw).toBeDefined();
    mock.done();
  });
});
