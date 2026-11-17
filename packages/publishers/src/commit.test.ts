import { afterAll, describe, expect, it } from 'vitest';
import { PublishError, commitPhase, toCommitted } from './errors';
import { makeAccount, makeMeta, makeRender, scriptedFetch, tempVideo, testCtx, TOKENS, type Step } from './testing/mock-fetch';
import { tiktokPublisher as tt } from './providers/tiktok';
import { xPublisher as x } from './providers/x';

const network = () => new PublishError('Network error: fetch failed', { code: 'network_error', retryable: true });
const http = (status: number, retryable: boolean) => new PublishError(`HTTP ${status}`, { code: `http_${status}`, retryable, status });

async function caught(p: Promise<unknown>): Promise<PublishError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PublishError) return e;
    throw e;
  }
  throw new Error('expected a PublishError');
}

describe('toCommitted', () => {
  it("'creating': no answer or a 5xx may have created the post -> committed, not retryable", () => {
    for (const err of [network(), http(503, true), new Error('socket hang up')]) {
      const out = toCommitted(err, 'creating') as PublishError;
      expect(out).toBeInstanceOf(PublishError);
      expect(out).toMatchObject({ committed: true, retryable: false });
      expect(out.externalId).toBeUndefined();
    }
  });

  it("'creating': a 4xx means the platform refused the request, so it stays retryable", () => {
    const limited = http(429, true);
    expect(toCommitted(limited, 'creating')).toBe(limited);
    const auth = new PublishError('expired', { code: 'auth', needsReconnect: true, status: 401 });
    expect(toCommitted(auth, 'creating')).toBe(auth);
  });

  it("'created': every retryable error is committed and carries the id to poll", () => {
    const out = toCommitted(http(429, true), 'created', 'pub-1') as PublishError;
    expect(out).toMatchObject({ committed: true, retryable: false, externalId: 'pub-1', code: 'http_429', status: 429 });
    const auth = toCommitted(new PublishError('revoked', { code: 'auth', needsReconnect: true, status: 401 }), 'created', 'pub-1') as PublishError;
    expect(auth).toMatchObject({ committed: true, needsReconnect: true, externalId: 'pub-1' });
  });

  it('definitive errors pass through unchanged in both phases', () => {
    const failed = new PublishError('platform rejected the video', { code: 'publish_failed' });
    expect(toCommitted(failed, 'creating')).toBe(failed);
    expect(toCommitted(failed, 'created', 'id')).toBe(failed);
  });

  it('commitPhase returns the value and converts a thrown error', async () => {
    await expect(commitPhase('created', async () => 7, 'id')).resolves.toBe(7);
    const err = await caught(commitPhase('created', async () => Promise.reject(network()), 'id'));
    expect(err).toMatchObject({ committed: true, externalId: 'id' });
  });
});

describe('adapters never ask for a second publish once the post may exist', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());
  const render = makeRender({ filePath: video.filePath });

  const TT = 'https://open.tiktokapis.com';
  const ok = { code: 'ok', message: '', log_id: 'log' };
  const UPLOAD = 'https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=x';
  const ttStart: Step[] = [
    {
      method: 'POST',
      url: `${TT}/v2/post/publish/creator_info/query/`,
      respond: {
        json: {
          data: { creator_username: 'k', creator_nickname: 'K', privacy_level_options: ['SELF_ONLY'], comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 300 },
          error: ok,
        },
      },
    },
    { method: 'POST', url: `${TT}/v2/post/publish/video/init/`, respond: { json: { data: { publish_id: 'pub-9', upload_url: UPLOAD }, error: ok } } },
  ];
  const ttMeta = makeMeta({ options: { privacyLevel: 'SELF_ONLY', consentAccepted: true } });

  it('tiktok: a failing status check after the upload -> committed with the publish_id (the engine polls it)', async () => {
    const mock = scriptedFetch([...ttStart, { method: 'PUT', url: UPLOAD, respond: { status: 201 } }, { method: 'POST', url: `${TT}/v2/post/publish/status/fetch/`, networkError: true }]);
    const err = await caught(tt.publish(testCtx(mock.fetch), { tokens: TOKENS, account: makeAccount(), render, meta: ttMeta }));
    expect(err).toMatchObject({ committed: true, retryable: false, externalId: 'pub-9' });
    mock.done();
  });

  it('tiktok: the last chunk losing its answer -> committed with the publish_id; a 429 on it stays retryable', async () => {
    let mock = scriptedFetch([...ttStart, { method: 'PUT', url: UPLOAD, networkError: true }]);
    let err = await caught(tt.publish(testCtx(mock.fetch), { tokens: TOKENS, account: makeAccount(), render, meta: ttMeta }));
    expect(err).toMatchObject({ committed: true, externalId: 'pub-9' });
    mock.done();

    mock = scriptedFetch([...ttStart, { method: 'PUT', url: UPLOAD, respond: { status: 429, json: { error: { code: 'rate_limit_exceeded', message: 'slow down' } } } }]);
    err = await caught(tt.publish(testCtx(mock.fetch), { tokens: TOKENS, account: makeAccount(), render, meta: ttMeta }));
    expect(err.committed).toBe(false);
    mock.done();
  });

  const XAPI = 'https://api.x.com/2';
  const xUpload: Step[] = [
    { method: 'POST', url: `${XAPI}/media/upload/initialize`, respond: { json: { data: { id: 'm1' } } } },
    { method: 'POST', url: `${XAPI}/media/upload/m1/append`, respond: { json: { data: {} } } },
    { method: 'POST', url: `${XAPI}/media/upload/m1/finalize`, respond: { json: { data: { id: 'm1' } } } },
  ];
  const xAccount = makeAccount({ externalAccountId: '42', username: 'klipz' });

  it('x: creating the post fails without an answer or with a 5xx -> committed (uncertain, no id)', async () => {
    for (const tweet of [{ networkError: true }, { respond: { status: 503, json: { title: 'Service Unavailable' } } }] as const) {
      const mock = scriptedFetch([...xUpload, { method: 'POST', url: `${XAPI}/tweets`, ...tweet }]);
      const err = await caught(x.publish(testCtx(mock.fetch, { chunkSizeBytes: '10' }), { tokens: TOKENS, account: xAccount, render, meta: makeMeta() }));
      expect(err).toMatchObject({ committed: true, retryable: false });
      expect(err.externalId).toBeUndefined();
      mock.done();
    }
  });

  it('x: a 429 on the create call was refused, so it stays retryable', async () => {
    const mock = scriptedFetch([...xUpload, { method: 'POST', url: `${XAPI}/tweets`, respond: { status: 429, json: { title: 'Too Many Requests' } } }]);
    const err = await caught(x.publish(testCtx(mock.fetch, { chunkSizeBytes: '10' }), { tokens: TOKENS, account: xAccount, render, meta: makeMeta() }));
    expect(err).toMatchObject({ committed: false, retryable: true });
    mock.done();
  });
});
