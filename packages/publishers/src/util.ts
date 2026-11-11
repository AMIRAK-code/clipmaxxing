import type { PostMetrics, PublisherContext } from './types';

export type Json = Record<string, unknown>;

export function asRecord(v: unknown): Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** Walk a nested object path safely. */
export function pick(v: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (typeof key === 'number') cur = asArray(cur)[key];
    else cur = asRecord(cur)[key];
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

export function nowOf(ctx: PublisherContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

export function sleepOf(ctx: PublisherContext): (ms: number) => Promise<void> {
  return ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
}

export function extraNum(ctx: PublisherContext, key: string, fallback: number): number {
  const n = num(ctx.config.extra?.[key]);
  return n !== undefined && n > 0 ? n : fallback;
}

export function reportProgress(ctx: PublisherContext, pct: number): void {
  if (!ctx.onProgress) return;
  try {
    ctx.onProgress(Math.max(0, Math.min(100, Math.round(pct))));
  } catch {
    /* progress callbacks must never break a publish */
  }
}

/** Drop undefined values. */
export function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Copy a Uint8Array into a standalone ArrayBuffer usable as a fetch body. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

type MetricKey = Exclude<keyof PostMetrics, 'raw'>;

/** Build a PostMetrics object, omitting metrics that are undefined. */
export function metricsOf(input: { [K in MetricKey]?: number | undefined } & { raw: unknown }): PostMetrics {
  const out: PostMetrics = { raw: input.raw };
  const keys: MetricKey[] = ['views', 'likes', 'comments', 'shares', 'saves', 'watchTimeSec', 'impressions'];
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
