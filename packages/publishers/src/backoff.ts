export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Returns a number in [0, 1). Defaults to Math.random. */
  jitter?: () => number;
}

/**
 * Exponential backoff with "equal jitter": half of the capped exponential delay is fixed,
 * the other half is randomised. `attempt` is 1-based.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? 1000;
  const maxMs = opts.maxMs ?? 5 * 60 * 1000;
  const jitter = opts.jitter ?? Math.random;
  const n = Math.max(1, Math.floor(Number.isFinite(attempt) ? attempt : 1));
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 30));
  const half = exp / 2;
  const j = Math.min(Math.max(jitter(), 0), 1);
  return Math.round(Math.min(maxMs, half + half * j));
}
