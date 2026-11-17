import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Everything KLIPZ stores lives in one folder outside the repo (and outside
// OneDrive): the SQLite database, media files and the local encryption key.
export function dataDir(): string {
  const dir = process.env.KLIPZ_DATA_DIR?.trim() || path.join(os.homedir(), ".klipz");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function storageDir(): string {
  const dir = path.join(dataDir(), "storage");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const dbPath = (): string => path.join(dataDir(), "klipz.db");

/** Repo root, found by walking up to the folder that holds db/migrations. */
export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "db", "migrations"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate repo root (db/migrations not found)");
}

/** Storage key → absolute path. Rejects anything that escapes the storage dir. */
export function storagePath(key: string): string {
  const root = storageDir();
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("Invalid storage key");
  return full;
}

/**
 * Remove a storage folder without blocking the request. Windows refuses to delete a file that is still
 * open (ffmpeg importing it, the page previewing it), so retry for a few seconds; anything still left is
 * swept by the worker's cleanup job. A failed delete of files must never fail the delete of the row.
 */
export function removeStorageDir(key: string): Promise<void> {
  return fs.promises
    .rm(storagePath(key), { recursive: true, force: true, maxRetries: 8, retryDelay: 400 })
    .catch((e: unknown) => console.warn(`[storage] could not remove ${key} yet: ${e instanceof Error ? e.message : String(e)}`));
}

export function ensureParent(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}
