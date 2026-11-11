/** Test-only helpers: a scripted fetch mock and fixtures. Not exported from the package index. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountInfo, PostMeta, PublisherContext, RenderAsset, TokenSet } from '../types';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

export interface ResponseSpec {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface Step {
  method?: string;
  /** String = match on URL without query (or the full URL when the string contains '?'). */
  url: string | RegExp;
  respond?: ResponseSpec | ((call: RecordedCall) => ResponseSpec);
  /** Throw (e.g. via expect) to fail the step. */
  check?: (call: RecordedCall) => void;
  /** Simulate a network failure. */
  networkError?: boolean;
}

export interface ScriptedFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Asserts every step was consumed in order and no step failed. */
  done(): void;
}

function toResponse(spec: ResponseSpec): Response {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers ?? {});
  let body: string | null = null;
  if (spec.json !== undefined) {
    body = JSON.stringify(spec.json);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  } else if (spec.text !== undefined) {
    body = spec.text;
  }
  const nullBody = status === 204 || status === 304 || status === 205;
  return new Response(nullBody ? null : body, { status, headers });
}

export function scriptedFetch(steps: Step[]): ScriptedFetch {
  const calls: RecordedCall[] = [];
  const failures: string[] = [];
  let index = 0;
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: RecordedCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers ?? {}),
      body: init?.body,
    };
    calls.push(call);
    const step = steps[index];
    const position = index;
    index++;
    if (!step) {
      failures.push(`unexpected call #${position}: ${call.method} ${url}`);
      return toResponse({ status: 599, text: 'unexpected call' });
    }
    const bare = url.split('?')[0];
    const urlOk = typeof step.url === 'string' ? (step.url.includes('?') ? url === step.url : bare === step.url) : step.url.test(url);
    if (!urlOk || (step.method && step.method.toUpperCase() !== call.method)) {
      failures.push(`call #${position}: expected ${step.method ?? '*'} ${String(step.url)} but got ${call.method} ${url}`);
      return toResponse({ status: 599, text: 'unexpected call' });
    }
    try {
      step.check?.(call);
    } catch (err) {
      failures.push(`call #${position} (${call.method} ${url}) check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (step.networkError) throw new TypeError('fetch failed');
    const spec = typeof step.respond === 'function' ? step.respond(call) : (step.respond ?? { json: {} });
    return toResponse(spec);
  };
  return {
    fetch: impl as typeof fetch,
    calls,
    done() {
      if (failures.length > 0) throw new Error(`fetch script violations:\n${failures.join('\n')}`);
      if (index < steps.length) throw new Error(`fetch script: only ${index} of ${steps.length} expected calls were made`);
    },
  };
}

export function jsonBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.body)) as Record<string, unknown>;
}

export function formBody(call: RecordedCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call.body)));
}

export function query(call: RecordedCall): Record<string, string> {
  return Object.fromEntries(new URL(call.url).searchParams);
}

export function bodyBytes(call: RecordedCall): number[] {
  if (call.body instanceof ArrayBuffer) return Array.from(new Uint8Array(call.body));
  throw new Error('body is not an ArrayBuffer');
}

export const FIXED_NOW = new Date('2026-11-10T20:00:00.000Z');

export function testCtx(fetchImpl: typeof fetch, extra: Record<string, string> = {}): PublisherContext & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    config: {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost:3000/api/oauth/test/callback',
      extra: { pollIntervalMs: '10', ...extra },
    },
    fetch: fetchImpl,
    now: () => FIXED_NOW,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    sleeps,
  };
}

/** Bytes 0..n-1 written to a temp file; call cleanup() in afterAll. */
export function tempVideo(size = 10): { filePath: string; bytes: number[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'klipz-publishers-'));
  const filePath = join(dir, 'render.mp4');
  const bytes = Array.from({ length: size }, (_, i) => i % 256);
  writeFileSync(filePath, Uint8Array.from(bytes));
  return { filePath, bytes, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeRender(overrides: Partial<RenderAsset> = {}): RenderAsset {
  return {
    filePath: 'C:/renders/does-not-exist.mp4',
    sizeBytes: 10,
    durationSec: 30,
    width: 1080,
    height: 1920,
    fps: 30,
    videoCodec: 'h264',
    audioCodec: 'aac',
    mimeType: 'video/mp4',
    ...overrides,
  };
}

export function makeMeta(overrides: Partial<PostMeta> = {}): PostMeta {
  return { caption: 'Hello world', hashtags: ['klipz', 'clips'], options: {}, ...overrides };
}

export const TOKENS: TokenSet = { accessToken: 'access-1', refreshToken: 'refresh-1', scopes: [] };

export function makeAccount(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return { externalAccountId: 'acct-1', displayName: 'Test Account', meta: {}, ...overrides };
}
