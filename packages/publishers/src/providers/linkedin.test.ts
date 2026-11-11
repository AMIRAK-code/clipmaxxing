import { afterAll, describe, expect, it } from 'vitest';
import { bodyBytes, formBody, jsonBody, makeAccount, makeMeta, makeRender, query, scriptedFetch, tempVideo, testCtx, TOKENS } from '../testing/mock-fetch';
import { escapeLinkedInText, linkedinPublisher as li } from './linkedin';

const REST = 'https://api.linkedin.com/rest';
const VIDEO_URN = 'urn:li:video:C5505AQH';
const VIDEO_URL = `${REST}/videos/${encodeURIComponent(VIDEO_URN)}`;
const POST_URN = 'urn:li:ugcPost:7000000000000000001';

describe('linkedin', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());
  const render = makeRender({ filePath: video.filePath, sizeBytes: 100_000 });
  const account = makeAccount({ externalAccountId: 'abc123', meta: { authorUrn: 'urn:li:person:abc123' } });

  it('builds the auth url', () => {
    const url = new URL(li.getAuthUrl(testCtx(scriptedFetch([]).fetch, { linkedinScopes: 'w_organization_social' }), { state: 's' }));
    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('scope')).toBe('openid profile w_member_social w_organization_social');
  });

  it('connect exchanges the code and derives the author urn', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: 'https://www.linkedin.com/oauth/v2/accessToken',
        check: (c) => expect(formBody(c)).toMatchObject({ grant_type: 'authorization_code', code: 'c', client_id: 'client-id', client_secret: 'client-secret' }),
        respond: { json: { access_token: 'liat', expires_in: 5184000, scope: 'openid,profile,w_member_social' } },
      },
      { method: 'GET', url: 'https://api.linkedin.com/v2/userinfo', respond: { json: { sub: 'abc123', name: 'Ada Lovelace', picture: 'https://img/li.jpg' } } },
    ]);
    const res = await li.connect(testCtx(mock.fetch), { code: 'c' });
    expect(res.tokens).toMatchObject({ accessToken: 'liat', scopes: ['openid', 'profile', 'w_member_social'] });
    expect(res.tokens.refreshToken).toBeUndefined();
    expect(res.accounts).toEqual([{ externalAccountId: 'abc123', displayName: 'Ada Lovelace', avatarUrl: 'https://img/li.jpg', meta: { authorUrn: 'urn:li:person:abc123', kind: 'member' } }]);
    mock.done();
  });

  it('publishes: initializeUpload -> PUT parts (ETags) -> finalizeUpload -> poll -> create post', async () => {
    const versionHeaders = (c: { headers: Headers }): void => {
      expect(c.headers.get('linkedin-version')).toBe('202610');
      expect(c.headers.get('x-restli-protocol-version')).toBe('2.0.0');
      expect(c.headers.get('authorization')).toBe('Bearer access-1');
    };
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: `${REST}/videos?action=initializeUpload`,
        check: (c) => {
          versionHeaders(c);
          expect(jsonBody(c)).toEqual({ initializeUploadRequest: { owner: 'urn:li:person:abc123', fileSizeBytes: 10, uploadCaptions: false, uploadThumbnail: false } });
        },
        respond: {
          json: {
            value: {
              uploadUrlsExpireAt: 1,
              video: VIDEO_URN,
              uploadToken: 'tok',
              uploadInstructions: [
                { uploadUrl: 'https://www.linkedin.com/dms-uploads/part1', firstByte: 0, lastByte: 5 },
                { uploadUrl: 'https://www.linkedin.com/dms-uploads/part2', firstByte: 6, lastByte: 9 },
              ],
            },
          },
        },
      },
      {
        method: 'PUT',
        url: 'https://www.linkedin.com/dms-uploads/part1',
        check: (c) => {
          expect(c.headers.get('content-type')).toBe('application/octet-stream');
          expect(c.headers.get('authorization')).toBeNull();
          expect(bodyBytes(c)).toEqual([0, 1, 2, 3, 4, 5]);
        },
        respond: { headers: { etag: '"etag-1"' } },
      },
      { method: 'PUT', url: 'https://www.linkedin.com/dms-uploads/part2', check: (c) => expect(bodyBytes(c)).toEqual([6, 7, 8, 9]), respond: { headers: { etag: '/ambry/etag-2.bin' } } },
      {
        method: 'POST',
        url: `${REST}/videos?action=finalizeUpload`,
        check: (c) => expect(jsonBody(c)).toEqual({ finalizeUploadRequest: { video: VIDEO_URN, uploadToken: 'tok', uploadedPartIds: ['etag-1', '/ambry/etag-2.bin'] } }),
        respond: { status: 200 },
      },
      { method: 'GET', url: VIDEO_URL, check: versionHeaders, respond: { json: { id: VIDEO_URN, status: 'PROCESSING' } } },
      { method: 'GET', url: VIDEO_URL, respond: { json: { id: VIDEO_URN, status: 'AVAILABLE' } } },
      {
        method: 'POST',
        url: `${REST}/posts`,
        check: (c) => {
          versionHeaders(c);
          expect(jsonBody(c)).toEqual({
            author: 'urn:li:person:abc123',
            commentary: 'Hello \\(world\\)\n\n#klipz #clips',
            visibility: 'PUBLIC',
            distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
            content: { media: { title: 'Clip', id: VIDEO_URN } },
            lifecycleState: 'PUBLISHED',
            isReshareDisabledByAuthor: false,
          });
        },
        respond: { status: 201, headers: { 'x-restli-id': POST_URN } },
      },
    ]);
    const result = await li.publish(testCtx(mock.fetch), { tokens: TOKENS, account, render, meta: makeMeta({ caption: 'Hello (world)', title: 'Clip' }) });
    expect(result).toEqual({ externalId: POST_URN, status: 'published', url: `https://www.linkedin.com/feed/update/${POST_URN}/` });
    mock.done();
  });

  it('escapes little-text reserved characters but keeps hashtags', () => {
    expect(escapeLinkedInText('a_b *c* (d) [e] {f} <g> @h #tag ~ | \\')).toBe('a\\_b \\*c\\* \\(d\\) \\[e\\] \\{f\\} \\<g\\> \\@h #tag \\~ \\| \\\\');
  });

  it('fails on PROCESSING_FAILED and asks for a retry when still processing', async () => {
    const init = [
      { method: 'POST', url: `${REST}/videos?action=initializeUpload`, respond: { json: { value: { video: VIDEO_URN, uploadToken: '', uploadInstructions: [{ uploadUrl: 'https://www.linkedin.com/dms-uploads/p', firstByte: 0, lastByte: 4194303 }] } } } },
      { method: 'PUT', url: 'https://www.linkedin.com/dms-uploads/p', check: (c: Parameters<typeof bodyBytes>[0]) => expect(bodyBytes(c)).toHaveLength(10), respond: { headers: { etag: 'e' } } },
      { method: 'POST', url: `${REST}/videos?action=finalizeUpload`, respond: { status: 200 } },
    ];
    const failed = scriptedFetch([...init, { method: 'GET', url: VIDEO_URL, respond: { json: { status: 'PROCESSING_FAILED', processingFailureReason: 'UNSUPPORTED_FORMAT' } } }]);
    await expect(li.publish(testCtx(failed.fetch), { tokens: TOKENS, account, render, meta: makeMeta() })).rejects.toMatchObject({ code: 'processing_failed', retryable: false });
    failed.done();
    const slow = scriptedFetch([...init, { method: 'GET', url: VIDEO_URL, respond: { json: { status: 'PROCESSING' } } }]);
    await expect(li.publish(testCtx(slow.fetch, { pollMaxAttempts: '1' }), { tokens: TOKENS, account, render, meta: makeMeta() })).rejects.toMatchObject({
      code: 'media_processing_timeout',
      retryable: true,
    });
    slow.done();
  });

  it('refreshes when a refresh token exists, otherwise asks to reconnect', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: 'https://www.linkedin.com/oauth/v2/accessToken',
        check: (c) => expect(formBody(c)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-id', client_secret: 'client-secret' }),
        respond: { json: { access_token: 'liat2', expires_in: 5184000, refresh_token: 'lirt2', refresh_token_expires_in: 31536000 } },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    expect(await li.refresh(ctx, TOKENS)).toMatchObject({ accessToken: 'liat2', refreshToken: 'lirt2' });
    await expect(li.refresh(ctx, { accessToken: 'a', scopes: [] })).rejects.toMatchObject({ code: 'auth_invalid', needsReconnect: true });
    mock.done();
  });

  it('maps 401 to needsReconnect, 429/503 to retryable', async () => {
    const url = `${REST}/videos?action=initializeUpload`;
    const mock = scriptedFetch([
      { method: 'POST', url, respond: { status: 401, json: { status: 401, serviceErrorCode: 65601, code: 'REVOKED_ACCESS_TOKEN', message: 'The token used in the request has been revoked by the user' } } },
      { method: 'POST', url, respond: { status: 429, headers: { 'retry-after': '120' }, json: { status: 429, message: 'Resource level throttle limit reached' } } },
      { method: 'POST', url, respond: { status: 503, json: { status: 503, message: 'Service Unavailable' } } },
      { method: 'POST', url, respond: { status: 403, json: { status: 403, code: 'ACCESS_DENIED', message: 'Not enough permissions to access: videos.ACTION-initializeUpload' } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const run = (): Promise<unknown> => li.publish(ctx, { tokens: TOKENS, account, render, meta: makeMeta() });
    await expect(run()).rejects.toMatchObject({ code: 'auth_invalid', needsReconnect: true });
    await expect(run()).rejects.toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSec: 120 });
    await expect(run()).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true });
    await expect(run()).rejects.toMatchObject({ code: 'permission_denied', needsReconnect: true });
    mock.done();
  });

  it('validates commentary length, duration, size and aspect', () => {
    const codes = (r = render, m = makeMeta()): string[] => li.validate(r, m).filter((i) => i.severity === 'error').map((i) => i.code);
    expect(codes()).toEqual([]);
    expect(codes(render, makeMeta({ caption: 'c'.repeat(3001) }))).toContain('caption_too_long');
    expect(codes(makeRender({ sizeBytes: 100_000, durationSec: 1801 }))).toContain('duration_too_long');
    expect(codes(makeRender({ sizeBytes: 1000 }))).toContain('file_too_small');
    expect(codes(makeRender({ sizeBytes: 600 * 1024 * 1024 }))).toContain('file_too_large');
    expect(codes(makeRender({ sizeBytes: 100_000, width: 400, height: 1920 }))).toContain('aspect_ratio_unsupported');
    expect(codes(render, makeMeta({ options: { visibility: 'PRIVATE' } }))).toContain('invalid_option');
  });

  it('parses status', async () => {
    const postUrl = `${REST}/posts/${encodeURIComponent(POST_URN)}`;
    const mock = scriptedFetch([
      { method: 'GET', url: postUrl, respond: { json: { id: POST_URN, lifecycleState: 'PUBLISHED' } } },
      { method: 'GET', url: postUrl, respond: { json: { id: POST_URN, lifecycleState: 'PUBLISH_FAILED' } } },
      { method: 'GET', url: postUrl, respond: { status: 404, json: { status: 404, message: 'Not found' } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const args = { tokens: TOKENS, account, externalId: POST_URN };
    expect(await li.getStatus(ctx, args)).toEqual({ status: 'published', url: `https://www.linkedin.com/feed/update/${POST_URN}/` });
    expect((await li.getStatus(ctx, args)).status).toBe('failed');
    expect((await li.getStatus(ctx, args)).status).toBe('failed');
    mock.done();
  });

  it('parses metrics and degrades gracefully without analytics permissions', async () => {
    const social = `${REST}/socialActions/${encodeURIComponent(POST_URN)}`;
    const mock = scriptedFetch([
      { method: 'GET', url: social, respond: { json: { likesSummary: { totalLikes: 12 }, commentsSummary: { aggregatedTotalComments: 3 } } } },
      {
        method: 'GET',
        url: /memberCreatorPostAnalytics/,
        check: (c) => {
          expect(c.url).toContain(`entity=(ugc:${encodeURIComponent(POST_URN)})`);
          expect(query(c).queryType).toBe('IMPRESSION');
        },
        respond: { json: { elements: [{ count: 950 }] } },
      },
      { method: 'GET', url: social, respond: { status: 403, json: { status: 403, code: 'ACCESS_DENIED', message: 'Not enough permissions to access: socialActions.GET' } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const full = await li.fetchMetrics(ctx, { tokens: { ...TOKENS, scopes: ['r_member_postAnalytics'] }, account, externalId: POST_URN });
    expect(full).toMatchObject({ likes: 12, comments: 3, impressions: 950 });
    const limited = await li.fetchMetrics(ctx, { tokens: TOKENS, account, externalId: POST_URN });
    expect(limited.likes).toBeUndefined();
    expect(limited.raw).toMatchObject({ socialActions: { unavailable: expect.any(String) } });
    mock.done();
  });
});
