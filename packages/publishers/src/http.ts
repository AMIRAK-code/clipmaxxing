import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { PublishError } from './errors';
import type { PublisherContext, RenderAsset } from './types';
import { asRecord, extraNum, nowOf, pick, reportProgress, sleepOf, str, toArrayBuffer } from './util';

export function getFetch(ctx: PublisherContext): typeof fetch {
  return ctx.fetch ?? globalThis.fetch;
}

export interface HttpErrorInfo {
  status: number;
  headers: Headers;
  /** Parsed JSON body when available, otherwise undefined. */
  body: unknown;
  text: string;
  now: Date;
}

/** Provider-specific error mapper. Return undefined to fall back to the default mapping. */
export type ErrorMapper = (info: HttpErrorInfo) => PublishError | undefined;

export interface HttpRequestOptions {
  method?: string;
  url: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Sets `Authorization: Bearer <token>`. */
  bearer?: string;
  /** JSON body (sets Content-Type: application/json). */
  json?: unknown;
  /** x-www-form-urlencoded body. */
  form?: Record<string, string | number | boolean | undefined>;
  /** Raw body (ArrayBuffer, FormData, string, ReadableStream ...). */
  body?: BodyInit;
  /** Required by Node fetch when `body` is a ReadableStream. */
  duplex?: 'half';
  /** Extra statuses (besides 2xx) to treat as success, e.g. 308 for resumable uploads. */
  okStatuses?: number[];
  mapError?: ErrorMapper;
}

export interface HttpResult<T> {
  status: number;
  headers: Headers;
  /** Parsed JSON, or undefined when the body was empty / not JSON. */
  data: T;
  text: string;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into seconds. */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.ceil(Number(trimmed)));
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}

export function extractErrorMessage(body: unknown, text: string): string {
  const candidates = [
    pick(body, 'error', 'message'),
    pick(body, 'error_description'),
    pick(body, 'message'),
    pick(body, 'detail'),
    pick(body, 'title'),
    typeof asRecord(body).error === 'string' ? asRecord(body).error : undefined,
  ];
  for (const c of candidates) {
    const s = str(c);
    if (s) return s;
  }
  return text.slice(0, 300);
}

/**
 * Default normalisation:
 *  401 -> needsReconnect, 429 -> retryable (Retry-After), 408/5xx -> retryable, other 4xx -> permanent.
 */
export function defaultHttpError(info: HttpErrorInfo): PublishError {
  const { status, headers, body, text, now } = info;
  const msg = extractErrorMessage(body, text) || `HTTP ${status}`;
  const retryAfterSec = parseRetryAfter(headers.get('retry-after'), now);
  const base = { status, providerPayload: body ?? text };
  if (status === 401) {
    return new PublishError(`Authorization failed: ${msg}`, { ...base, code: 'auth_invalid', needsReconnect: true });
  }
  if (status === 429) {
    return new PublishError(`Rate limited: ${msg}`, {
      ...base,
      code: 'rate_limited',
      retryable: true,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    });
  }
  if (status === 408 || status >= 500) {
    return new PublishError(`Provider unavailable (HTTP ${status}): ${msg}`, {
      ...base,
      code: 'provider_unavailable',
      retryable: true,
      ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
    });
  }
  if (status === 403) return new PublishError(`Forbidden: ${msg}`, { ...base, code: 'forbidden' });
  if (status === 404) return new PublishError(`Not found: ${msg}`, { ...base, code: 'not_found' });
  return new PublishError(`Provider error (HTTP ${status}): ${msg}`, { ...base, code: 'provider_error' });
}

function buildUrl(url: string, query?: HttpRequestOptions['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
}

/** Single HTTP call through the injectable fetch with PublishError normalisation. */
export async function httpRequest<T = unknown>(ctx: PublisherContext, req: HttpRequestOptions): Promise<HttpResult<T>> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.bearer) headers.Authorization = `Bearer ${req.bearer}`;
  let body: BodyInit | undefined = req.body;
  if (req.json !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = JSON.stringify(req.json);
  } else if (req.form !== undefined) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.form)) if (v !== undefined) params.set(k, String(v));
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = params.toString();
  }
  const method = req.method ?? (body !== undefined ? 'POST' : 'GET');
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = body;
  if (ctx.signal) init.signal = ctx.signal;
  if (req.duplex) (init as RequestInit & { duplex: 'half' }).duplex = req.duplex;

  let res: Response;
  try {
    res = await getFetch(ctx)(buildUrl(req.url, req.query), init);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    throw new PublishError(`Network error: ${err instanceof Error ? err.message : String(err)}`, {
      code: 'network_error',
      retryable: true,
    });
  }

  const text = await res.text().catch(() => '');
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  const ok = (res.status >= 200 && res.status < 300) || (req.okStatuses?.includes(res.status) ?? false);
  if (!ok) {
    const info: HttpErrorInfo = { status: res.status, headers: res.headers, body: data, text, now: nowOf(ctx) };
    throw req.mapError?.(info) ?? defaultHttpError(info);
  }
  return { status: res.status, headers: res.headers, data: data as T, text };
}

/* ------------------------------------------------------------------ */
/* Asset source: bounded-memory reads from a local file or a URL       */
/* ------------------------------------------------------------------ */

export interface AssetSource {
  /** Total size in bytes. */
  size: number;
  /** Read bytes [start, endExclusive). */
  readChunk(start: number, endExclusive: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** In-memory source (tests, small buffers). */
export function memoryAssetSource(bytes: Uint8Array): AssetSource {
  return {
    size: bytes.byteLength,
    readChunk: async (start, endExclusive) => bytes.slice(start, Math.min(endExclusive, bytes.byteLength)),
    close: async () => {},
  };
}

/** Fetch bytes [start, endExclusive) of a URL with an HTTP Range request. */
export async function fetchRange(ctx: PublisherContext, url: string, start: number, endExclusive: number): Promise<Uint8Array> {
  const init: RequestInit = { method: 'GET', headers: { Range: `bytes=${start}-${endExclusive - 1}` } };
  if (ctx.signal) init.signal = ctx.signal;
  let res: Response;
  try {
    res = await getFetch(ctx)(url, init);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    throw new PublishError(`Could not download render: ${err instanceof Error ? err.message : String(err)}`, {
      code: 'asset_download_failed',
      retryable: true,
    });
  }
  if (res.status !== 206 && res.status !== 200) {
    throw new PublishError(`Could not download render (HTTP ${res.status})`, {
      code: 'asset_download_failed',
      retryable: res.status >= 500 || res.status === 429,
      status: res.status,
    });
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range answers 200 with the whole file: slice out what we need.
  if (res.status === 200 && buf.byteLength > endExclusive - start) return buf.slice(start, endExclusive);
  return buf;
}

/**
 * Open the rendered video for chunked reading. Local file (node:fs) is preferred; falls back to
 * Range requests against render.url. Always `close()` the source (use `withAssetSource`).
 */
export async function openAssetSource(render: RenderAsset, ctx: PublisherContext): Promise<AssetSource> {
  if (render.filePath) {
    if (!isAbsolute(render.filePath)) {
      throw new PublishError('Render filePath must be an absolute path', { code: 'asset_unreadable' });
    }
    let handle;
    try {
      handle = await open(render.filePath, 'r');
    } catch (err) {
      throw new PublishError(`Cannot open render file: ${err instanceof Error ? err.message : String(err)}`, {
        code: 'asset_unreadable',
      });
    }
    const stat = await handle.stat();
    const size = stat.size;
    if (size === 0) {
      await handle.close().catch(() => {});
      throw new PublishError('Render file is empty', { code: 'asset_unreadable' });
    }
    return {
      size,
      async readChunk(start, endExclusive) {
        const end = Math.min(endExclusive, size);
        const length = Math.max(0, end - start);
        const buf = new Uint8Array(length);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(buf, read, length - read, start + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return read === length ? buf : buf.slice(0, read);
      },
      close: () => handle.close(),
    };
  }
  if (render.url) {
    const url = render.url;
    return {
      size: render.sizeBytes,
      readChunk: (start, endExclusive) => fetchRange(ctx, url, start, Math.min(endExclusive, render.sizeBytes)),
      close: async () => {},
    };
  }
  throw new PublishError('Render has neither filePath nor url', { code: 'asset_missing' });
}

export async function withAssetSource<T>(
  render: RenderAsset,
  ctx: PublisherContext,
  fn: (source: AssetSource) => Promise<T>,
): Promise<T> {
  const source = await openAssetSource(render, ctx);
  try {
    return await fn(source);
  } finally {
    await source.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Streaming request bodies (bounded memory)                            */
/* ------------------------------------------------------------------ */

/** Files at or below this size are sent as a single in-memory buffer (fast path). */
export const STREAM_THRESHOLD_BYTES = 8 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 1024 * 1024;

/** `config.extra.uploadMode = "buffer"` restores the old read-everything-into-memory behaviour. */
export function shouldStream(ctx: PublisherContext, size: number): boolean {
  if (ctx.config.extra?.uploadMode === 'buffer') return false;
  return size > STREAM_THRESHOLD_BYTES;
}

/** Pull-based stream over [0, source.size): at most one ~1 MiB chunk is in memory at a time. */
export function assetReadableStream(ctx: PublisherContext, source: AssetSource, chunkBytes = STREAM_CHUNK_BYTES): ReadableStream<Uint8Array> {
  let offset = 0;
  const total = source.size;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= total) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkBytes, total);
      const bytes = await source.readChunk(offset, end);
      if (bytes.byteLength !== end - offset) {
        controller.error(new PublishError('Render read returned fewer bytes than expected', { code: 'asset_read_mismatch', retryable: true }));
        return;
      }
      offset = end;
      controller.enqueue(bytes);
      reportProgress(ctx, (offset / total) * 100);
      if (offset >= total) controller.close();
    },
  });
}

/**
 * Streaming multipart/form-data body: text fields, then one file part streamed from `source`.
 * Content-Length is computed up front (head + file size + tail).
 */
export function streamingMultipart(
  ctx: PublisherContext,
  fields: Array<[string, string]>,
  file: { field: string; filename: string; contentType: string; source: AssetSource },
): { body: ReadableStream<Uint8Array>; contentType: string; contentLength: number } {
  const boundary = `----klipz${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const esc = (v: string): string => v.replace(/[\r\n"]/g, (c) => (c === '"' ? '%22' : ' '));
  const enc = new TextEncoder();
  const head = enc.encode(
    fields.map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${esc(k)}"\r\n\r\n${v}\r\n`).join('') +
      `--${boundary}\r\nContent-Disposition: form-data; name="${esc(file.field)}"; filename="${esc(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const inner = assetReadableStream(ctx, file.source).getReader();
  let stage: 0 | 1 = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        controller.enqueue(head);
        return;
      }
      const { done, value } = await inner.read();
      if (done) {
        controller.enqueue(tail);
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel: (reason) => inner.cancel(reason),
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, contentLength: head.byteLength + file.source.size + tail.byteLength };
}

export interface ByteRange {
  index: number;
  /** inclusive */
  start: number;
  /** inclusive */
  end: number;
}

/** Split [0, totalBytes) into fixed-size ranges (last one may be shorter). */
export function planChunks(totalBytes: number, chunkSize: number): ByteRange[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const out: ByteRange[] = [];
  for (let start = 0, index = 0; start < totalBytes; start += size, index++) {
    out.push({ index, start, end: Math.min(start + size, totalBytes) - 1 });
  }
  return out;
}

export interface UploadChunk extends ByteRange {
  total: number;
  isLast: boolean;
  /** Standalone ArrayBuffer, safe to hand to fetch as a body. */
  data: ArrayBuffer;
}

/**
 * Read the asset range by range (one chunk in memory at a time) and hand each chunk to `handler`.
 * Reports progress through ctx.onProgress.
 */
export async function uploadInChunks(
  ctx: PublisherContext,
  source: AssetSource,
  ranges: ByteRange[],
  handler: (chunk: UploadChunk) => Promise<void>,
): Promise<void> {
  const total = source.size;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (!range) continue;
    const bytes = await source.readChunk(range.start, range.end + 1);
    if (bytes.byteLength !== range.end - range.start + 1) {
      throw new PublishError(
        `Render read returned ${bytes.byteLength} bytes for range ${range.start}-${range.end}`,
        { code: 'asset_read_mismatch', retryable: true },
      );
    }
    await handler({ ...range, total, isLast: i === ranges.length - 1, data: toArrayBuffer(bytes) });
    reportProgress(ctx, total > 0 ? ((range.end + 1) / total) * 100 : 100);
  }
}

export function chunkSizeOf(ctx: PublisherContext, fallback: number): number {
  return extraNum(ctx, 'chunkSizeBytes', fallback);
}

/* ------------------------------------------------------------------ */
/* Polling                                                              */
/* ------------------------------------------------------------------ */

export interface PollOptions {
  maxAttempts: number;
  intervalMs: number;
}

export function pollOptionsOf(ctx: PublisherContext, defaults: PollOptions): PollOptions {
  return {
    maxAttempts: Math.floor(extraNum(ctx, 'pollMaxAttempts', defaults.maxAttempts)),
    intervalMs: extraNum(ctx, 'pollIntervalMs', defaults.intervalMs),
  };
}

/**
 * Call `check` until it reports done or maxAttempts is reached. Never blocks forever:
 * returns `{ done: false, value: lastValue }` when the cap is hit.
 * `check` may return `waitMs` to override the delay before the next attempt.
 */
export async function pollUntil<T>(
  ctx: PublisherContext,
  check: (attempt: number) => Promise<{ done: boolean; value: T; waitMs?: number }>,
  opts: PollOptions,
): Promise<{ done: boolean; value: T; attempts: number }> {
  const sleep = sleepOf(ctx);
  const max = Math.max(1, opts.maxAttempts);
  let last: { done: boolean; value: T; waitMs?: number } | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    last = await check(attempt);
    if (last.done) return { done: true, value: last.value, attempts: attempt };
    if (attempt < max) await sleep(last.waitMs ?? opts.intervalMs);
  }
  return { done: false, value: (last as { value: T }).value, attempts: max };
}
