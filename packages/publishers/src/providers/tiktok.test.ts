import { afterAll, describe, expect, it } from 'vitest';
import { bodyBytes, formBody, jsonBody, makeAccount, makeMeta, makeRender, query, scriptedFetch, tempVideo, testCtx, TOKENS } from '../testing/mock-fetch';
import {
  TIKTOK_CONSENT_TEXT,
  TIKTOK_CONSENT_TEXT_BRANDED,
  getTikTokConsentText,
  getTikTokCreatorInfo,
  getTikTokDisclosureLabel,
  planTikTokChunks,
  tiktokPublisher as tt,
} from './tiktok';

const API = 'https://open.tiktokapis.com';
const CREATOR = `${API}/v2/post/publish/creator_info/query/`;
const INIT = `${API}/v2/post/publish/video/init/`;
const STATUS = `${API}/v2/post/publish/status/fetch/`;
const ok = { code: 'ok', message: '', log_id: 'log' };
const creatorData = {
  creator_avatar_url: 'https://img/a.jpg',
  creator_username: 'klipzer',
  creator_nickname: 'Klipzer',
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: false,
  max_video_post_duration_sec: 300,
};
const goodOptions = { privacyLevel: 'SELF_ONLY', consentAccepted: true };

describe('tiktok', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());
  const render = makeRender({ filePath: video.filePath });

  it('builds the auth url with client_key, comma scopes and PKCE', () => {
    const url = new URL(tt.getAuthUrl(testCtx(scriptedFetch([]).fetch), { state: 'st', codeChallenge: 'cc' }));
    expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(url.searchParams.get('client_key')).toBe('client-id');
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.publish,video.list');
    expect(url.searchParams.get('code_challenge')).toBe('cc');
  });

  it('connect exchanges the code and loads the user', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: `${API}/v2/oauth/token/`,
        check: (c) => expect(formBody(c)).toMatchObject({ client_key: 'client-id', client_secret: 'client-secret', grant_type: 'authorization_code', code: 'c', code_verifier: 'v' }),
        respond: { json: { access_token: 'act.1', refresh_token: 'rft.1', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'oid', scope: 'user.info.basic,video.publish,video.list', token_type: 'Bearer' } },
      },
      {
        method: 'GET',
        url: `${API}/v2/user/info/`,
        check: (c) => expect(query(c).fields).toContain('display_name'),
        respond: { json: { data: { user: { open_id: 'oid', display_name: 'Klipzer', avatar_url: 'https://img/a.jpg' } }, error: ok } },
      },
    ]);
    const res = await tt.connect(testCtx(mock.fetch), { code: 'c', codeVerifier: 'v' });
    expect(res.tokens).toMatchObject({ accessToken: 'act.1', refreshToken: 'rft.1', scopes: ['user.info.basic', 'video.publish', 'video.list'] });
    expect(res.accounts[0]).toMatchObject({ externalAccountId: 'oid', displayName: 'Klipzer', avatarUrl: 'https://img/a.jpg' });
    mock.done();
  });

  it('exposes creator info for the UI', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: CREATOR, check: (c) => expect(c.headers.get('authorization')).toBe('Bearer access-1'), respond: { json: { data: creatorData, error: ok } } },
    ]);
    const info = await getTikTokCreatorInfo(testCtx(mock.fetch), TOKENS);
    expect(info).toEqual({
      creatorAvatarUrl: 'https://img/a.jpg',
      creatorUsername: 'klipzer',
      creatorNickname: 'Klipzer',
      privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
      commentDisabled: false,
      duetDisabled: true,
      stitchDisabled: false,
      maxVideoPostDurationSec: 300,
    });
    mock.done();
  });

  it('publishes with FILE_UPLOAD by default: creator_info -> init -> PUT -> status polling', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: CREATOR, respond: { json: { data: creatorData, error: ok } } },
      {
        method: 'POST',
        url: INIT,
        check: (c) => {
          expect(c.headers.get('content-type')).toBe('application/json; charset=UTF-8');
          const body = jsonBody(c) as { post_info: Record<string, unknown>; source_info: Record<string, unknown> };
          expect(body.source_info).toEqual({ source: 'FILE_UPLOAD', video_size: 10, chunk_size: 10, total_chunk_count: 1 });
          expect(body.post_info).toEqual({
            title: 'Hello world\n\n#klipz #clips',
            privacy_level: 'SELF_ONLY',
            disable_comment: false,
            disable_duet: true, // forced by creator_info.duet_disabled
            disable_stitch: false,
            video_cover_timestamp_ms: 1500,
            brand_content_toggle: false,
            brand_organic_toggle: false,
          });
        },
        respond: { json: { data: { publish_id: 'v_pub_file~v2.123', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=x' }, error: ok } },
      },
      {
        method: 'PUT',
        url: 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=x',
        check: (c) => {
          expect(c.headers.get('content-range')).toBe('bytes 0-9/10');
          expect(c.headers.get('content-type')).toBe('video/mp4');
          expect(bodyBytes(c)).toEqual(video.bytes);
        },
        respond: { status: 201 },
      },
      { method: 'POST', url: STATUS, check: (c) => expect(jsonBody(c)).toEqual({ publish_id: 'v_pub_file~v2.123' }), respond: { json: { data: { status: 'PROCESSING_UPLOAD' }, error: ok } } },
      { method: 'POST', url: STATUS, respond: { json: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7412345678901234567n.toString()] }, error: ok } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const result = await tt.publish(ctx, { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta({ coverTimestampMs: 1500, options: goodOptions }) });
    expect(result).toEqual({ externalId: 'v_pub_file~v2.123', status: 'published', url: 'https://www.tiktok.com/@klipzer/video/7412345678901234567' });
    expect(ctx.sleeps).toEqual([10]);
    mock.done();
  });

  it('uses PULL_FROM_URL only when asked and returns processing when the poll cap is hit', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: CREATOR, respond: { json: { data: creatorData, error: ok } } },
      {
        method: 'POST',
        url: INIT,
        check: (c) => expect((jsonBody(c) as { source_info: unknown }).source_info).toEqual({ source: 'PULL_FROM_URL', video_url: 'https://cdn.klipz.test/r.mp4' }),
        respond: { json: { data: { publish_id: 'v_pub_url~v2.9' }, error: ok } },
      },
      { method: 'POST', url: STATUS, respond: { json: { data: { status: 'PROCESSING_DOWNLOAD' }, error: ok } } },
      { method: 'POST', url: STATUS, respond: { json: { data: { status: 'PROCESSING_DOWNLOAD' }, error: ok } } },
    ]);
    const ctx = testCtx(mock.fetch, { tiktokSource: 'pull', pollMaxAttempts: '2' });
    const result = await tt.publish(ctx, {
      tokens: TOKENS,
      account: makeAccount(),
      render: makeRender({ filePath: undefined, url: 'https://cdn.klipz.test/r.mp4' }),
      meta: makeMeta({ options: goodOptions }),
    });
    expect(result).toEqual({ externalId: 'v_pub_url~v2.9', status: 'processing' });
    mock.done();
  });

  it('plans FILE_UPLOAD chunks per TikTok rules', () => {
    const MB = 1024 * 1024;
    expect(planTikTokChunks(3 * MB)).toMatchObject({ chunkSize: 3 * MB, totalChunkCount: 1 });
    const plan = planTikTokChunks(50_000_123, 10_000_000);
    expect(plan.chunkSize).toBe(10_000_000);
    expect(plan.totalChunkCount).toBe(5);
    expect(plan.ranges[0]).toEqual({ index: 0, start: 0, end: 9_999_999 });
    expect(plan.ranges[4]).toEqual({ index: 4, start: 40_000_000, end: 50_000_122 });
    expect(planTikTokChunks(100 * MB, 1).chunkSize).toBe(5 * MB); // clamped to the 5 MB minimum
    expect(planTikTokChunks(1000 * MB, 500 * MB).chunkSize).toBe(64 * MB);
  });

  it('refuses to post when the privacy level is not offered to the creator', async () => {
    const mock = scriptedFetch([{ method: 'POST', url: CREATOR, respond: { json: { data: { ...creatorData, privacy_level_options: ['SELF_ONLY'] }, error: ok } } }]);
    await expect(
      tt.publish(testCtx(mock.fetch), { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta({ options: { privacyLevel: 'PUBLIC_TO_EVERYONE', consentAccepted: true } }) }),
    ).rejects.toMatchObject({ code: 'privacy_level_option_mismatch' });
    mock.done();
    await expect(tt.publish(testCtx(scriptedFetch([]).fetch), { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta({ options: { consentAccepted: true } }) })).rejects.toMatchObject({
      code: 'privacy_required',
    });
    await expect(tt.publish(testCtx(scriptedFetch([]).fetch), { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta({ options: { privacyLevel: 'SELF_ONLY' } }) })).rejects.toMatchObject({
      code: 'consent_required',
    });
  });

  it('refreshes tokens (rotating refresh token)', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: `${API}/v2/oauth/token/`,
        check: (c) => expect(formBody(c)).toEqual({ client_key: 'client-id', client_secret: 'client-secret', grant_type: 'refresh_token', refresh_token: 'refresh-1' }),
        respond: { json: { access_token: 'act.2', refresh_token: 'rft.2', expires_in: 86400, scope: 'user.info.basic,video.publish' } },
      },
    ]);
    const next = await tt.refresh(testCtx(mock.fetch), TOKENS);
    expect(next).toMatchObject({ accessToken: 'act.2', refreshToken: 'rft.2', expiresAt: '2026-11-11T20:00:00.000Z' });
    mock.done();
  });

  it('maps an HTTP-200 token error and access_token_invalid to needsReconnect', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: `${API}/v2/oauth/token/`, respond: { json: { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.', log_id: 'x' } } },
      { method: 'POST', url: CREATOR, respond: { status: 401, json: { data: {}, error: { code: 'access_token_invalid', message: 'The access token is invalid or not found in the request.', log_id: 'x' } } } },
    ]);
    const ctx = testCtx(mock.fetch);
    await expect(tt.refresh(ctx, TOKENS)).rejects.toMatchObject({ code: 'auth_invalid', needsReconnect: true });
    await expect(tt.publish(ctx, { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta({ options: goodOptions }) })).rejects.toMatchObject({
      code: 'auth_invalid',
      needsReconnect: true,
      retryable: false,
    });
    mock.done();
  });

  it('maps rate limits, daily caps and server errors to retryable; unaudited to permanent', async () => {
    const init = (status: number, code: string) => [
      { method: 'POST', url: CREATOR, respond: { json: { data: creatorData, error: ok } } },
      { method: 'POST', url: INIT, respond: { status, json: { data: {}, error: { code, message: 'm', log_id: 'x' } } } },
    ];
    const run = async (status: number, code: string): Promise<unknown> => {
      const mock = scriptedFetch(init(status, code));
      try {
        await tt.publish(testCtx(mock.fetch), { tokens: TOKENS, account: makeAccount(), render, meta: makeMeta({ options: goodOptions }) });
      } catch (e) {
        mock.done();
        return e;
      }
      throw new Error('expected failure');
    };
    expect(await run(429, 'rate_limit_exceeded')).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSec: 60 });
    expect(await run(403, 'spam_risk_too_many_posts')).toMatchObject({ code: 'post_limit_reached', retryable: true, retryAfterSec: 86400 });
    expect(await run(500, 'internal_error')).toMatchObject({ code: 'provider_unavailable', retryable: true });
    expect(await run(403, 'unaudited_client_can_only_post_to_private_accounts')).toMatchObject({ code: 'unaudited_client', retryable: false, needsReconnect: false });
  });

  it('validate enforces the audit UX rules', () => {
    const errs = (options: Record<string, unknown>, account = makeAccount()): string[] =>
      tt.validate(render, makeMeta({ options }), account).filter((i) => i.severity === 'error').map((i) => i.code);
    expect(errs({})).toEqual(expect.arrayContaining(['privacy_required', 'consent_required']));
    expect(errs({ privacyLevel: 'SELF_ONLY' })).toEqual(['consent_required']);
    expect(errs(goodOptions)).toEqual([]);
    expect(errs({ ...goodOptions, discloseCommercialContent: true })).toEqual(['disclosure_incomplete']);
    expect(errs({ ...goodOptions, discloseCommercialContent: true, brandContentToggle: true })).toEqual(['branded_content_private']);
    expect(errs({ privacyLevel: 'PUBLIC_TO_EVERYONE', consentAccepted: true, discloseCommercialContent: true, brandContentToggle: true, brandOrganicToggle: true })).toEqual([]);
    expect(errs({ ...goodOptions, brandOrganicToggle: true })).toEqual(['disclosure_inconsistent']);
    expect(errs({ privacyLevel: 'EVERYONE', consentAccepted: true })).toContain('invalid_option');

    const account = makeAccount({ meta: { creatorInfo: { privacyLevelOptions: ['SELF_ONLY'], commentDisabled: true, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 60 } } });
    expect(errs({ privacyLevel: 'PUBLIC_TO_EVERYONE', consentAccepted: true }, account)).toEqual(['privacy_not_available']);
    const long = tt.validate(makeRender({ durationSec: 61 }), makeMeta({ options: goodOptions }), account);
    expect(long.map((i) => i.code)).toEqual(expect.arrayContaining(['duration_too_long', 'interaction_disabled_by_creator']));
  });

  it('validate checks caption length, aspect and duration', () => {
    const codes = (r = render, m = makeMeta({ options: goodOptions })): string[] => tt.validate(r, m).map((i) => i.code);
    expect(codes(render, makeMeta({ caption: 'c'.repeat(2201), hashtags: [], options: goodOptions }))).toContain('caption_too_long');
    expect(codes(makeRender({ width: 4000, height: 400 }))).toContain('aspect_ratio_unsupported');
    expect(codes(makeRender({ durationSec: 601 }))).toContain('duration_too_long');
    expect(codes(makeRender({ durationSec: 2 }))).toContain('duration_too_short');
    expect(codes(makeRender({ fps: 15 }))).toContain('fps_unsupported');
  });

  it('exports the required consent copy', () => {
    expect(TIKTOK_CONSENT_TEXT).toBe("By posting, you agree to TikTok's Music Usage Confirmation");
    expect(getTikTokConsentText({})).toBe(TIKTOK_CONSENT_TEXT);
    expect(getTikTokConsentText({ brandOrganicToggle: true })).toBe(TIKTOK_CONSENT_TEXT);
    expect(getTikTokConsentText({ brandContentToggle: true })).toBe(TIKTOK_CONSENT_TEXT_BRANDED);
    expect(TIKTOK_CONSENT_TEXT_BRANDED).toContain('Branded Content Policy and Music Usage Confirmation');
    expect(getTikTokDisclosureLabel({ brandOrganicToggle: true })).toContain('Promotional content');
    expect(getTikTokDisclosureLabel({ brandContentToggle: true, brandOrganicToggle: true })).toContain('Paid partnership');
    expect(getTikTokDisclosureLabel({})).toBeUndefined();
  });

  it('parses status', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: STATUS, respond: { json: { data: { status: 'PROCESSING_UPLOAD' }, error: ok } } },
      { method: 'POST', url: STATUS, respond: { json: { data: { status: 'FAILED', fail_reason: 'file_format_check_failed' }, error: ok } } },
      { method: 'POST', url: STATUS, respond: { json: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['777'] }, error: ok } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const args = { tokens: TOKENS, account: makeAccount({ username: 'klipzer' }), externalId: 'v_pub_file~v2.1' };
    expect(await tt.getStatus(ctx, args)).toEqual({ status: 'processing' });
    expect(await tt.getStatus(ctx, args)).toEqual({ status: 'failed', error: 'TikTok publish failed: file_format_check_failed' });
    expect(await tt.getStatus(ctx, args)).toEqual({ status: 'published', url: 'https://www.tiktok.com/@klipzer/video/777' });
    mock.done();
  });

  it('fetches metrics via video/query after resolving the public video id', async () => {
    const mock = scriptedFetch([
      { method: 'POST', url: STATUS, respond: { json: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['777'] }, error: ok } } },
      {
        method: 'POST',
        url: `${API}/v2/video/query/`,
        check: (c) => {
          expect(query(c).fields).toContain('view_count');
          expect(jsonBody(c)).toEqual({ filters: { video_ids: ['777'] } });
        },
        respond: { json: { data: { videos: [{ id: '777', view_count: 1000, like_count: 90, comment_count: 8, share_count: 7 }] }, error: ok } },
      },
      { method: 'POST', url: STATUS, respond: { json: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }, error: ok } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const m = await tt.fetchMetrics(ctx, { tokens: TOKENS, account: makeAccount(), externalId: 'v_pub_file~v2.1' });
    expect(m).toMatchObject({ views: 1000, likes: 90, comments: 8, shares: 7 });
    const none = await tt.fetchMetrics(ctx, { tokens: TOKENS, account: makeAccount(), externalId: 'v_pub_file~v2.2' });
    expect(none.views).toBeUndefined();
    mock.done();
  });
});
