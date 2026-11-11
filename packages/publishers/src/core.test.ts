import { afterAll, describe, expect, it } from 'vitest';
import {
  PLATFORM_LIMITS,
  PROVIDERS,
  PublishError,
  backoffDelayMs,
  composeCaption,
  createPkce,
  decryptToken,
  encryptToken,
  ensureFreshTokens,
  fetchRange,
  generateEncryptionKey,
  getPublisher,
  httpRequest,
  memoryAssetSource,
  openAssetSource,
  parseRetryAfter,
  planChunks,
  pollUntil,
  signState,
  startConnect,
  uploadInChunks,
  verifyState,
  xWeightedLength,
  type Publisher,
  type TokenSet,
} from './index';
import { createHash } from 'node:crypto';
import { FIXED_NOW, makeMeta, makeRender, scriptedFetch, tempVideo, testCtx } from './testing/mock-fetch';

describe('composeCaption', () => {
  it('appends hashtags, dedupes and strips invalid characters', () => {
    const out = composeCaption('instagram', makeMeta({ caption: 'Big news #klipz', hashtags: ['#klipz', 'Clips', 'two words', '', 'CLIPS'] }));
    expect(out).toBe('Big news #klipz\n\n#Clips #twowords');
  });

  it('adds #Shorts on YouTube exactly once', () => {
    expect(composeCaption('youtube', makeMeta({ caption: 'Watch this', hashtags: ['fun'] }))).toBe('Watch this\n\n#fun #Shorts');
    expect(composeCaption('youtube', makeMeta({ caption: 'Watch this #shorts', hashtags: ['Shorts'] }))).toBe('Watch this #shorts');
  });

  it('never cuts a hashtag in half and respects the X weighted limit', () => {
    const caption = 'word '.repeat(50).trim(); // 249 chars
    const out = composeCaption('x', makeMeta({ caption, hashtags: ['alpha', 'averyveryverylonghashtagthatwillnotfit', 'beta'] }));
    expect(xWeightedLength(out)).toBeLessThanOrEqual(280);
    expect(out.endsWith('#alpha')).toBe(true);
    expect(out).not.toContain('#avery');
    for (const token of out.split(/\s+/).filter((t) => t.startsWith('#'))) {
      expect(['#alpha', '#beta']).toContain(token);
    }
  });

  it('truncates an over-long caption on a word boundary and still keeps #Shorts', () => {
    const caption = 'lorem ipsum '.repeat(600); // 7200 chars
    const out = composeCaption('youtube', makeMeta({ caption, hashtags: [] }));
    expect(out.length).toBeLessThanOrEqual(PLATFORM_LIMITS.youtube.captionMax);
    expect(out.endsWith('\u2026\n\n#Shorts')).toBe(true);
    expect(out).toMatch(/(lorem|ipsum)\u2026\n\n#Shorts$/);
  });

  it('drops a trailing inline hashtag rather than splitting it', () => {
    const caption = `${'a'.repeat(270)} #superlonghashtag`;
    const out = composeCaption('x', makeMeta({ caption, hashtags: [] }));
    expect(out).toBe(`${'a'.repeat(270)}\u2026`);
  });

  it('counts URLs as 23 and wide characters as 2 for X', () => {
    expect(xWeightedLength('see https://example.com/a/very/long/path/that/is/long')).toBe(4 + 23);
    expect(xWeightedLength('\u65e5\u672c')).toBe(4);
    expect(xWeightedLength('abc')).toBe(3);
  });

  it('caps the number of hashtags on Instagram at 30', () => {
    const hashtags = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    const out = composeCaption('instagram', makeMeta({ caption: 'x', hashtags }));
    expect(out.match(/#/g)?.length).toBe(30);
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially with bounded jitter', () => {
    expect(backoffDelayMs(1, { baseMs: 1000, jitter: () => 0 })).toBe(500);
    expect(backoffDelayMs(1, { baseMs: 1000, jitter: () => 1 })).toBe(1000);
    expect(backoffDelayMs(3, { baseMs: 1000, jitter: () => 0 })).toBe(2000);
    expect(backoffDelayMs(3, { baseMs: 1000, jitter: () => 1 })).toBe(4000);
  });

  it('caps at maxMs and tolerates silly input', () => {
    expect(backoffDelayMs(50, { baseMs: 1000, maxMs: 30_000, jitter: () => 1 })).toBe(30_000);
    expect(backoffDelayMs(0, { baseMs: 200, jitter: () => 1 })).toBe(200);
    for (let i = 0; i < 20; i++) {
      const d = backoffDelayMs(4, { baseMs: 100 });
      expect(d).toBeGreaterThanOrEqual(400);
      expect(d).toBeLessThanOrEqual(800);
    }
  });
});

describe('token encryption', () => {
  const key = generateEncryptionKey();

  it('round-trips with a v1:iv:tag:ciphertext envelope', () => {
    const enc = encryptToken('s3cr\u00e9t-token', key);
    expect(enc.split(':')).toHaveLength(4);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('s3cr');
    expect(decryptToken(enc, key)).toBe('s3cr\u00e9t-token');
    expect(encryptToken('s3cr\u00e9t-token', key)).not.toBe(enc); // random IV
  });

  it('detects tampering, wrong keys and bad keys', () => {
    const enc = encryptToken('token', key);
    const parts = enc.split(':');
    const data = parts[3] ?? '';
    const flipped = (data[0] === 'A' ? 'B' : 'A') + data.slice(1);
    expect(() => decryptToken([parts[0], parts[1], parts[2], flipped].join(':'), key)).toThrow(PublishError);
    expect(() => decryptToken(enc, generateEncryptionKey())).toThrow(/authentication/);
    expect(() => decryptToken('v2:a:b:c', key)).toThrow(/Malformed/);
    expect(() => encryptToken('x', Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('PKCE and OAuth state', () => {
  it('creates an S256 challenge for the verifier', () => {
    const { codeVerifier, codeChallenge } = createPkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).toBe(createHash('sha256').update(codeVerifier).digest('base64url'));
  });

  it('signs and verifies state', () => {
    const state = signState({ workspaceId: 'ws_1', provider: 'tiktok' }, 'secret', { now: () => FIXED_NOW });
    const payload = verifyState(state, 'secret', { now: () => FIXED_NOW });
    expect(payload).toMatchObject({ workspaceId: 'ws_1', provider: 'tiktok' });
    expect(payload.nonce.length).toBeGreaterThan(10);
  });

  it('rejects expired, tampered and wrongly signed state', () => {
    const state = signState({ workspaceId: 'ws_1', provider: 'x', nonce: 'n' }, 'secret', { now: () => FIXED_NOW, ttlSec: 60 });
    const later = (): Date => new Date(FIXED_NOW.getTime() + 61_000);
    expect(() => verifyState(state, 'secret', { now: later })).toThrow(/expired/);
    expect(() => verifyState(state, 'other-secret', { now: () => FIXED_NOW })).toThrow(/Invalid/);
    const [body, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ w: 'ws_2', p: 'x', n: 'n', e: 9999999999 })).toString('base64url');
    expect(() => verifyState(`${forged}.${sig}`, 'secret')).toThrow(/Invalid/);
    expect(() => verifyState(`${body}`, 'secret')).toThrow(/Invalid/);
    expect(() => verifyState('garbage', 'secret')).toThrow(PublishError);
  });

  it('startConnect returns auth url, signed state and verifier', () => {
    const ctx = testCtx(scriptedFetch([]).fetch);
    const start = startConnect(getPublisher('x'), ctx, { workspaceId: 'local', stateSecret: 'secret' });
    const url = new URL(start.authUrl);
    expect(url.searchParams.get('state')).toBe(start.state);
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(start.codeVerifier ?? '').digest('base64url'));
    expect(verifyState(start.state, 'secret', { now: () => FIXED_NOW }).provider).toBe('x');
  });
});

describe('http helper', () => {
  it('parses Retry-After as seconds or date', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('Tue, 10 Nov 2026 20:01:00 GMT', FIXED_NOW)).toBe(60);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  it('normalises errors: 401 reconnect, 429/5xx retryable, network retryable, 400 permanent', async () => {
    const mock = scriptedFetch([
      { url: 'https://api.test/a', respond: { status: 401, json: { error: { message: 'bad token' } } } },
      { url: 'https://api.test/a', respond: { status: 429, headers: { 'retry-after': '30' }, json: { message: 'slow down' } } },
      { url: 'https://api.test/a', respond: { status: 503, text: 'oops' } },
      { url: 'https://api.test/a', networkError: true },
      { url: 'https://api.test/a', respond: { status: 400, json: { error_description: 'nope' } } },
    ]);
    const ctx = testCtx(mock.fetch);
    const grab = async (): Promise<PublishError> => {
      try {
        await httpRequest(ctx, { url: 'https://api.test/a' });
      } catch (e) {
        return e as PublishError;
      }
      throw new Error('expected failure');
    };
    const e401 = await grab();
    expect(e401).toBeInstanceOf(PublishError);
    expect(e401).toMatchObject({ code: 'auth_invalid', needsReconnect: true, retryable: false, status: 401 });
    expect(await grab()).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterSec: 30 });
    expect(await grab()).toMatchObject({ code: 'provider_unavailable', retryable: true, needsReconnect: false });
    expect(await grab()).toMatchObject({ code: 'network_error', retryable: true });
    const e400 = await grab();
    expect(e400).toMatchObject({ code: 'provider_error', retryable: false, needsReconnect: false });
    expect(e400.message).toContain('nope');
    mock.done();
  });

  it('sends JSON / form bodies and bearer auth', async () => {
    const mock = scriptedFetch([
      {
        method: 'POST',
        url: 'https://api.test/json',
        check: (c) => {
          expect(c.headers.get('authorization')).toBe('Bearer tok');
          expect(c.headers.get('content-type')).toBe('application/json');
          expect(JSON.parse(String(c.body))).toEqual({ a: 1 });
        },
        respond: { json: { ok: true } },
      },
      {
        method: 'POST',
        url: 'https://api.test/form?x=1',
        check: (c) => expect(String(c.body)).toBe('a=b&n=2'),
        respond: { status: 204 },
      },
    ]);
    const ctx = testCtx(mock.fetch);
    const res = await httpRequest<{ ok: boolean }>(ctx, { url: 'https://api.test/json', json: { a: 1 }, bearer: 'tok' });
    expect(res.data.ok).toBe(true);
    const empty = await httpRequest(ctx, { url: 'https://api.test/form', query: { x: 1, skip: undefined }, form: { a: 'b', n: 2, u: undefined } });
    expect(empty.status).toBe(204);
    expect(empty.data).toBeUndefined();
    mock.done();
  });
});

describe('asset source and chunked upload helper', () => {
  const video = tempVideo(10);
  afterAll(() => video.cleanup());

  it('plans chunk ranges', () => {
    expect(planChunks(10, 4)).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 7 },
      { index: 2, start: 8, end: 9 },
    ]);
    expect(planChunks(8, 4)).toHaveLength(2);
    expect(planChunks(0, 4)).toEqual([]);
  });

  it('reads a local file chunk by chunk', async () => {
    const ctx = testCtx(scriptedFetch([]).fetch);
    const source = await openAssetSource(makeRender({ filePath: video.filePath }), ctx);
    expect(source.size).toBe(10);
    expect(Array.from(await source.readChunk(4, 8))).toEqual([4, 5, 6, 7]);
    expect(Array.from(await source.readChunk(8, 100))).toEqual([8, 9]);
    await source.close();
  });

  it('falls back to Range requests for a URL source', async () => {
    const data = Uint8Array.from(video.bytes);
    const mock = scriptedFetch([
      {
        url: 'https://cdn.test/v.mp4',
        check: (c) => expect(c.headers.get('range')).toBe('bytes=0-3'),
        respond: () => ({ status: 206, text: String.fromCharCode(...data.slice(0, 4)) }),
      },
      {
        // server ignoring Range -> 200 with the full body, helper slices
        url: 'https://cdn.test/v.mp4',
        check: (c) => expect(c.headers.get('range')).toBe('bytes=4-9'),
        respond: () => ({ status: 200, text: String.fromCharCode(...data) }),
      },
    ]);
    const ctx = testCtx(mock.fetch);
    const source = await openAssetSource(makeRender({ filePath: undefined, url: 'https://cdn.test/v.mp4' }), ctx);
    expect(Array.from(await source.readChunk(0, 4))).toEqual([0, 1, 2, 3]);
    expect(Array.from(await source.readChunk(4, 10))).toEqual([4, 5, 6, 7, 8, 9]);
    mock.done();
  });

  it('maps a failed range download to a PublishError', async () => {
    const mock = scriptedFetch([{ url: 'https://cdn.test/v.mp4', respond: { status: 503 } }]);
    await expect(fetchRange(testCtx(mock.fetch), 'https://cdn.test/v.mp4', 0, 4)).rejects.toMatchObject({
      code: 'asset_download_failed',
      retryable: true,
    });
  });

  it('errors clearly when the file is missing or no source is set', async () => {
    const ctx = testCtx(scriptedFetch([]).fetch);
    await expect(openAssetSource(makeRender({ filePath: 'C:/nope/missing.mp4' }), ctx)).rejects.toMatchObject({ code: 'asset_unreadable' });
    await expect(openAssetSource(makeRender({ filePath: undefined }), ctx)).rejects.toMatchObject({ code: 'asset_missing' });
  });

  it('uploads chunks in order with bounded memory and reports progress', async () => {
    const progress: number[] = [];
    const ctx = { ...testCtx(scriptedFetch([]).fetch), onProgress: (p: number) => progress.push(p) };
    const seen: Array<{ start: number; end: number; bytes: number[]; isLast: boolean }> = [];
    let reads = 0;
    const inner = memoryAssetSource(Uint8Array.from(video.bytes));
    const source = { ...inner, readChunk: async (s: number, e: number) => (reads++, inner.readChunk(s, e)) };
    await uploadInChunks(ctx, source, planChunks(source.size, 4), async (chunk) => {
      seen.push({ start: chunk.start, end: chunk.end, bytes: Array.from(new Uint8Array(chunk.data)), isLast: chunk.isLast });
      expect(chunk.total).toBe(10);
    });
    expect(reads).toBe(3);
    expect(seen).toEqual([
      { start: 0, end: 3, bytes: [0, 1, 2, 3], isLast: false },
      { start: 4, end: 7, bytes: [4, 5, 6, 7], isLast: false },
      { start: 8, end: 9, bytes: [8, 9], isLast: true },
    ]);
    expect(progress).toEqual([40, 80, 100]);
  });

  it('pollUntil stops at the cap instead of blocking forever', async () => {
    const ctx = testCtx(scriptedFetch([]).fetch);
    let n = 0;
    const capped = await pollUntil(ctx, async () => ({ done: false, value: ++n }), { maxAttempts: 3, intervalMs: 7 });
    expect(capped).toEqual({ done: false, value: 3, attempts: 3 });
    expect(ctx.sleeps).toEqual([7, 7]);
    const ok = await pollUntil(ctx, async (attempt) => ({ done: attempt === 2, value: attempt }), { maxAttempts: 5, intervalMs: 1 });
    expect(ok).toMatchObject({ done: true, value: 2, attempts: 2 });
  });
});

describe('ensureFreshTokens', () => {
  const fake = (calls: TokenSet[]): Publisher => ({
    ...getPublisher('youtube'),
    refresh: async (_ctx, tokens) => {
      calls.push(tokens);
      return { ...tokens, accessToken: 'new', expiresAt: '2026-11-10T21:00:00.000Z' };
    },
  });

  it('refreshes only inside the skew window', async () => {
    const calls: TokenSet[] = [];
    const ctx = testCtx(scriptedFetch([]).fetch);
    const fresh: TokenSet = { accessToken: 'a', refreshToken: 'r', scopes: [], expiresAt: '2026-11-10T20:10:00.000Z' };
    expect(await ensureFreshTokens(fake(calls), ctx, fresh)).toEqual({ tokens: fresh, refreshed: false });
    const stale: TokenSet = { ...fresh, expiresAt: '2026-11-10T20:04:00.000Z' };
    const out = await ensureFreshTokens(fake(calls), ctx, stale);
    expect(out.refreshed).toBe(true);
    expect(out.tokens.accessToken).toBe('new');
    expect(calls).toHaveLength(1);
    const noExpiry: TokenSet = { accessToken: 'page-token', scopes: [] };
    expect((await ensureFreshTokens(fake(calls), ctx, noExpiry)).refreshed).toBe(false);
    expect((await ensureFreshTokens(fake(calls), ctx, fresh, 900)).refreshed).toBe(true);
  });
});

describe('limits and registry', () => {
  it('has limits and a native publisher for every provider', () => {
    for (const provider of PROVIDERS) {
      const publisher = getPublisher(provider);
      expect(publisher.provider).toBe(provider);
      expect(publisher.limits).toBe(PLATFORM_LIMITS[provider]);
      expect(PLATFORM_LIMITS[provider].captionMax).toBeGreaterThan(0);
    }
    expect(PLATFORM_LIMITS.youtube.maxDurationSec).toBe(180);
    expect(PLATFORM_LIMITS.x.captionMax).toBe(280);
    expect(PLATFORM_LIMITS.facebook.maxDurationSec).toBe(90);
    expect(PLATFORM_LIMITS.linkedin.captionMax).toBe(3000);
  });

  it('validate() never throws on garbage input', () => {
    for (const provider of PROVIDERS) {
      const issues = getPublisher(provider).validate(
        makeRender({ filePath: undefined, sizeBytes: 0, durationSec: 0, width: 0, height: 0, fps: 0, videoCodec: '', audioCodec: '' }),
        makeMeta({ options: { privacyLevel: 42, visibility: 7, privacyStatus: 'nope', title: 5 } as Record<string, unknown> }),
      );
      expect(issues.some((i) => i.code === 'asset_missing')).toBe(true);
      expect(issues.every((i) => i.severity === 'error' || i.severity === 'warning')).toBe(true);
    }
  });
});
