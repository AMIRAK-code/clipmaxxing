import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPublisher } from './registry';
import { facebookPublisher as fb } from './providers/facebook';
import { instagramPublisher as ig } from './providers/instagram';
import { tiktokPublisher as tt, withTikTokAudited } from './providers/tiktok';
import { xPublisher as x } from './providers/x';
import { formBody, makeAccount, makeMeta, makeRender, query, scriptedFetch, testCtx, TOKENS } from './testing/mock-fetch';

const MB = 1024 * 1024;
const BIG = 300 * MB;
const MID = 150 * MB;
const G = 'https://graph.facebook.com/v27.0';

/** Records what a streamed request body looked like without ever holding it in memory. */
interface Consumed {
  total: number;
  maxChunk: number;
  markers: { start: number[]; mid: number[]; end: number[] };
  nonZero: number;
  peakRss: number;
  head: string;
  tail: string;
}

async function consume(body: unknown, baselineHolder: { rss: number }): Promise<Consumed> {
  if (!(body instanceof ReadableStream)) throw new Error('body is not a ReadableStream');
  const out: Consumed = { total: 0, maxChunk: 0, markers: { start: [], mid: [], end: [] }, nonZero: 0, peakRss: 0, head: '', tail: '' };
  const reader = body.getReader();
  let offset = 0;
  let first = true;
  let last: Uint8Array | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    out.maxChunk = Math.max(out.maxChunk, chunk.byteLength);
    out.peakRss = Math.max(out.peakRss, process.memoryUsage().rss - baselineHolder.rss);
    if (first) out.head = Buffer.from(chunk.subarray(0, Math.min(chunk.byteLength, 4096))).toString('latin1');
    first = false;
    last = chunk;
    for (let i = 0; i < chunk.byteLength; i++) if (chunk[i] !== 0) out.nonZero++;
    offset += chunk.byteLength;
    out.total = offset;
  }
  if (last) out.tail = Buffer.from(last.subarray(Math.max(0, last.byteLength - 64))).toString('latin1');
  return out;
}

describe('bounded-memory uploads (300 MB sparse file)', () => {
  let dir: string;
  let filePath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'klipz-big-'));
    filePath = join(dir, 'big.mp4');
    const fd = openSync(filePath, 'w');
    ftruncateSync(fd, BIG);
    writeSync(fd, Uint8Array.from([1, 2, 3, 4]), 0, 4, 0);
    writeSync(fd, Uint8Array.from([9, 9, 9, 9]), 0, 4, MID);
    writeSync(fd, Uint8Array.from([7, 7, 7, 7]), 0, 4, BIG - 4);
    closeSync(fd);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const render = (): ReturnType<typeof makeRender> => makeRender({ filePath, sizeBytes: BIG });
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('instagram rupload streams the file: every byte arrives, chunks stay small, RSS stays flat', async () => {
    const baseline = { rss: process.memoryUsage().rss };
    let seen: Consumed | undefined;
    let headers: Headers | undefined;
    let duplex: unknown;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const path = url.split('?')[0] ?? '';
      if (path === `${G}/ig1/content_publishing_limit`) return json(200, { data: [{ quota_usage: 0, config: { quota_total: 100 } }] });
      if (path === `${G}/ig1/media`) return json(200, { id: 'c1', uri: 'https://rupload.facebook.com/ig-api-upload/v27.0/c1' });
      if (path.startsWith('https://rupload.facebook.com/')) {
        headers = new Headers(init?.headers);
        duplex = (init as { duplex?: string }).duplex;
        seen = await consume(init?.body, baseline);
        return json(200, { success: true });
      }
      if (path === `${G}/c1`) return json(200, { status_code: 'FINISHED' });
      if (path === `${G}/ig1/media_publish`) return json(200, { id: 'm1' });
      if (path === `${G}/m1`) return json(200, { id: 'm1', permalink: 'https://www.instagram.com/reel/x/' });
      return json(599, {});
    }) as typeof fetch;
    const res = await ig.publish(testCtx(fetchImpl), { tokens: TOKENS, account: makeAccount({ externalAccountId: 'ig1', meta: { igUserId: 'ig1' } }), render: render(), meta: makeMeta() });
    expect(res.status).toBe('published');
    expect(seen?.total).toBe(BIG);
    expect(seen?.maxChunk).toBeLessThanOrEqual(1 * MB);
    expect(seen?.nonZero).toBe(12); // 1,2,3,4 + 9x4 + 7x4
    expect(seen?.peakRss).toBeLessThan(120 * MB);
    expect(headers?.get('content-length')).toBe(String(BIG));
    expect(headers?.get('file_size')).toBe(String(BIG));
    expect(headers?.get('offset')).toBe('0');
    expect(duplex).toBe('half');
  }, 120_000);

  it('facebook rupload streams the file', async () => {
    const baseline = { rss: process.memoryUsage().rss };
    let seen: Consumed | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input).split('?')[0] ?? '';
      if (path === `${G}/p1/video_reels` && String(init?.body).includes('start')) return json(200, { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v27.0/v1' });
      if (path.startsWith('https://rupload.facebook.com/')) {
        seen = await consume(init?.body, baseline);
        return json(200, { success: true });
      }
      if (path === `${G}/p1/video_reels`) return json(200, { success: true });
      if (path === `${G}/v1`) return json(200, { status: { video_status: 'ready', publishing_phase: { publish_status: 'published' } } });
      return json(599, {});
    }) as typeof fetch;
    const res = await fb.publish(testCtx(fetchImpl), { tokens: { ...TOKENS, accessToken: 'page-token' }, account: makeAccount({ externalAccountId: 'p1', meta: { pageId: 'p1' } }), render: render(), meta: makeMeta() });
    expect(res.status).toBe('published');
    expect(seen?.total).toBe(BIG);
    expect(seen?.maxChunk).toBeLessThanOrEqual(1 * MB);
    expect(seen?.nonZero).toBe(12);
    expect(seen?.peakRss).toBeLessThan(120 * MB);
  }, 120_000);

  it('upload-post streams a multipart body with a correct Content-Length', async () => {
    const baseline = { rss: process.memoryUsage().rss };
    let seen: Consumed | undefined;
    let headers: Headers | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      headers = new Headers(init?.headers);
      seen = await consume(init?.body, baseline);
      return json(200, { success: true, request_id: 'req-9' });
    }) as typeof fetch;
    const pub = getPublisher('tiktok', { aggregator: { kind: 'upload-post', apiKey: 'k', providers: ['tiktok'], profileKey: 'me' } });
    const res = await pub.publish(testCtx(fetchImpl), {
      tokens: TOKENS,
      account: makeAccount(),
      render: render(),
      meta: makeMeta({ options: { privacyLevel: 'SELF_ONLY', consentAccepted: true } }),
    });
    expect(res).toEqual({ externalId: 'req-9', status: 'processing' });
    expect(seen?.total).toBe(Number(headers?.get('content-length')));
    expect(seen?.total).toBeGreaterThan(BIG);
    expect(seen?.total).toBeLessThan(BIG + 4096);
    expect(seen?.nonZero).toBeGreaterThanOrEqual(12);
    expect(seen?.maxChunk).toBeLessThanOrEqual(1 * MB);
    expect(seen?.peakRss).toBeLessThan(120 * MB);
    expect(headers?.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen?.head).toContain('name="user"');
    expect(seen?.head).toContain('name="video"; filename="video.mp4"');
    expect(seen?.tail).toMatch(/--\r\n$/);
    expect(headers?.get('authorization')).toBe('Apikey k');
  }, 120_000);

  it('uploadMode=buffer restores the in-memory ArrayBuffer body (small file here)', async () => {
    const small = join(dir, 'small.mp4');
    const fd = openSync(small, 'w');
    writeSync(fd, Uint8Array.from([5, 6, 7]));
    closeSync(fd);
    let bodyType = '';
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input).split('?')[0] ?? '';
      if (path.startsWith('https://rupload.facebook.com/')) {
        bodyType = (init?.body as object).constructor.name;
        return json(200, { success: true });
      }
      if (path === `${G}/p1/video_reels` && String(init?.body).includes('start')) return json(200, { video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v27.0/v1' });
      if (path === `${G}/p1/video_reels`) return json(200, { success: true });
      return json(200, { status: { video_status: 'ready', publishing_phase: { publish_status: 'published' } } });
    }) as typeof fetch;
    await fb.publish(testCtx(fetchImpl, { uploadMode: 'buffer' }), { tokens: TOKENS, account: makeAccount({ externalAccountId: 'p1', meta: { pageId: 'p1' } }), render: makeRender({ filePath: small, sizeBytes: 3 }), meta: makeMeta() });
    expect(bodyType).toBe('ArrayBuffer');
  });
});

describe('instagram container already PUBLISHED', () => {
  const account = makeAccount({ externalAccountId: 'ig1', meta: { igUserId: 'ig1' } });
  const quota = { method: 'GET', url: `${G}/ig1/content_publishing_limit`, respond: { json: { data: [{ quota_usage: 1, config: { quota_total: 100 } }] } } };

  it('does not call media_publish again; resolves the media id', async () => {
    const mock = scriptedFetch([
      quota,
      { method: 'POST', url: `${G}/ig1/media`, respond: { json: { id: 'c9' } } },
      { method: 'GET', url: `${G}/c9`, respond: { json: { status_code: 'PUBLISHED' } } },
      {
        method: 'GET',
        url: `${G}/ig1/media`,
        check: (c) => expect(query(c).limit).toBe('1'),
        respond: { json: { data: [{ id: 'media9', permalink: 'https://www.instagram.com/reel/z/', media_product_type: 'REELS' }] } },
      },
    ]);
    const res = await ig.publish(testCtx(mock.fetch), { tokens: TOKENS, account, render: makeRender({ filePath: undefined, url: 'https://cdn.klipz.test/r.mp4' }), meta: makeMeta() });
    expect(res).toEqual({ externalId: 'media9', status: 'published', url: 'https://www.instagram.com/reel/z/' });
    expect(mock.calls.some((c) => c.url.includes('media_publish'))).toBe(false);
    mock.done();
  });

  it('getStatus on a PUBLISHED container never re-publishes either', async () => {
    const mock = scriptedFetch([
      { method: 'GET', url: `${G}/c9`, respond: { json: { status_code: 'PUBLISHED' } } },
      { method: 'GET', url: `${G}/ig1/media`, respond: { json: { data: [{ id: 'media9' }] } } },
    ]);
    const st = await ig.getStatus(testCtx(mock.fetch), { tokens: TOKENS, account, externalId: 'container:c9' });
    expect(st).toEqual({ status: 'published', externalId: 'media9' });
    expect(mock.calls.some((c) => c.url.includes('media_publish'))).toBe(false);
    mock.done();
  });
});

describe('x 403 mapping', () => {
  const account = makeAccount({ externalAccountId: '42', username: 'klipz' });
  const API = 'https://api.x.com/2';
  const run = async (body: unknown) => {
    const mock = scriptedFetch([{ method: 'POST', url: `${API}/media/upload/initialize`, respond: { status: 403, json: body } }]);
    const dir = mkdtempSync(join(tmpdir(), 'klipz-x-'));
    const file = join(dir, 'v.mp4');
    const fd = openSync(file, 'w');
    writeSync(fd, Uint8Array.from([1, 2, 3]));
    closeSync(fd);
    try {
      await x.publish(testCtx(mock.fetch), { tokens: TOKENS, account, render: makeRender({ filePath: file, sizeBytes: 3 }), meta: makeMeta() });
      return undefined;
    } catch (e) {
      return e as { code: string; retryable: boolean; message: string };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('access-level / enrollment restrictions -> tier_required', async () => {
    const e1 = await run({ title: 'Client Forbidden', detail: 'App not attached to a project', reason: 'client-not-enrolled', type: 'https://api.twitter.com/2/problems/client-forbidden' });
    expect(e1?.code).toBe('tier_required');
    const e2 = await run({ title: 'Forbidden', detail: 'Your access level does not permit this endpoint.' });
    expect(e2?.code).toBe('tier_required');
    const e3 = await run({ title: 'UsageCapExceeded', detail: 'Usage cap exceeded: Monthly product cap', type: 'https://api.twitter.com/2/problems/usage-capped' });
    expect(e3?.code).toBe('tier_required');
  });

  it('duplicate content -> duplicate_content, non-retryable', async () => {
    const e = await run({ title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' });
    expect(e).toMatchObject({ code: 'duplicate_content', retryable: false });
  });

  it('other 403 -> forbidden with the platform message', async () => {
    const e = await run({ title: 'Forbidden', detail: 'You are not permitted to reply to this conversation.' });
    expect(e?.code).toBe('forbidden');
    expect(e?.message).toContain('not permitted to reply');
  });
});

describe('tiktok unaudited warning', () => {
  const opts = (privacyLevel: string) => makeMeta({ options: { privacyLevel, consentAccepted: true } });
  const codes = (issues: Array<{ code: string; severity: string }>) => issues.filter((i) => i.code === 'unaudited_app_forced_private');

  it('warns (not errors) for non-private posts unless audited', () => {
    const acct = makeAccount();
    const warn = codes(tt.validate(makeRender(), opts('PUBLIC_TO_EVERYONE'), withTikTokAudited(acct, { extra: {} })));
    expect(warn).toHaveLength(1);
    expect(warn[0]?.severity).toBe('warning');
    expect(codes(tt.validate(makeRender(), opts('PUBLIC_TO_EVERYONE'), acct))).toHaveLength(1);
    expect(codes(tt.validate(makeRender(), opts('PUBLIC_TO_EVERYONE'), withTikTokAudited(acct, { extra: { tiktokAudited: 'true' } })))).toHaveLength(0);
    expect(codes(tt.validate(makeRender(), opts('SELF_ONLY'), acct))).toHaveLength(0);
  });
});

void formBody;
