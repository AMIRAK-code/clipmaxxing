// Helpers for the on-disk Remotion bundle cache. Several render processes may run at once, so a
// bundle is built into a private temp directory and renamed into place (atomic), and stale
// bundles are only pruned once they are old enough that nobody can still be serving them.
import fs from "node:fs";
import path from "node:path";

export const STALE_MS = 60 * 60 * 1000;

/** Remove cache entries other than `keep` that were last modified more than `maxAgeMs` ago. */
export function pruneStale(cacheRoot, keep, maxAgeMs = STALE_MS, now = Date.now()) {
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(cacheRoot);
  } catch {
    return removed;
  }
  for (const name of entries) {
    if (name === keep) continue;
    const p = path.join(cacheRoot, name);
    try {
      if (now - fs.statSync(p).mtimeMs < maxAgeMs) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // another process may be touching it; leave it
    }
  }
  return removed;
}

/**
 * Build a bundle with `build(tmpDir)` unless `<cacheRoot>/<hash>/index.html` already exists.
 * The result is moved into place atomically; a concurrent winner is reused. Returns the final dir.
 */
export async function ensureBundle(cacheRoot, hash, build) {
  const dir = path.join(cacheRoot, hash);
  const ready = () => fs.existsSync(path.join(dir, "index.html"));
  if (ready()) return dir;
  fs.mkdirSync(cacheRoot, { recursive: true });
  const tmp = path.join(cacheRoot, `${hash}.tmp-${process.pid}-${Date.now()}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    await build(tmp);
    try {
      fs.renameSync(tmp, dir);
    } catch (err) {
      if (!ready()) throw err;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  pruneStale(cacheRoot, hash);
  return dir;
}
