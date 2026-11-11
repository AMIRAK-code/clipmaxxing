export const STALE_MS: number;
export function pruneStale(cacheRoot: string, keep: string, maxAgeMs?: number, now?: number): string[];
export function ensureBundle(cacheRoot: string, hash: string, build: (tmpDir: string) => Promise<void>): Promise<string>;
