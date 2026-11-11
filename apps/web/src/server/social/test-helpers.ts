// Test-only helpers (not imported by app code).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROVIDERS, type Provider, type SocialAccount } from "@klipz/shared";
import { PLATFORM_LIMITS, generateEncryptionKey, type Publisher } from "@klipz/publishers";
import { newId, openDb, run, setDb } from "../db";
import { storagePath } from "../paths";
import { upsertAccounts } from "./accounts";

export const MIGRATIONS = path.resolve(__dirname, "../../../../../db/migrations");

/** Call at the very top of a test file (before importing server code that reads the data dir). */
export function setupTestEnv(prefix: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `klipz-${prefix}-`));
  process.env.KLIPZ_DATA_DIR = tmp;
  process.env.TOKEN_ENCRYPTION_KEY = generateEncryptionKey();
  process.env.OAUTH_STATE_SECRET = "test-state-secret";
  for (const k of ["KLIPZ_PUBLISH_MOCK", "AGGREGATOR_KIND", "AGGREGATOR_API_KEY", "AGGREGATOR_PROVIDERS", "ANTHROPIC_API_KEY"]) delete process.env[k];
  return tmp;
}

const opened: { close(): void }[] = [];
export function freshDb(tmp: string): void {
  const d = openDb(path.join(tmp, `t-${newId()}.db`), MIGRATIONS);
  opened.push(d);
  setDb(d);
}
export function cleanup(tmp: string): void {
  setDb(undefined);
  for (const d of opened) {
    try {
      d.close();
    } catch {
      /* already closed */
    }
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may hold a WAL handle */
  }
}

export interface Seed {
  projectId: string;
  sourceId: string;
  clipId: string;
  renderId: string;
}

/** A project + clip + READY render whose mp4 exists on disk (dummy bytes). */
export function seedClip(opts: { durationSec?: number; withFile?: boolean } = {}): Seed {
  const projectId = newId();
  const sourceId = newId();
  const clipId = newId();
  const renderId = newId();
  run("insert into projects (id, title) values (?, 'P')", projectId);
  run("insert into source_videos (id, project_id, origin, status, duration_sec) values (?, ?, 'upload', 'ready', 100)", sourceId, projectId);
  run("insert into clips (id, project_id, source_video_id, start_sec, end_sec, title, hook) values (?, ?, ?, 10, 18, 'Clip title', 'Why sleep matters')", clipId, projectId, sourceId);
  const key = `renders/${renderId}/clip.mp4`;
  run(
    `insert into renders (id, clip_id, status, storage_key, cover_key, width, height, fps, duration_sec, size_bytes, video_codec, audio_codec, lufs, edit_version, completed_at)
     values (?, ?, 'ready', ?, ?, 1080, 1920, 30, ?, 5000000, 'h264', 'aac', -14, 0, ?)`,
    renderId,
    clipId,
    key,
    `renders/${renderId}/cover.jpg`,
    opts.durationSec ?? 8,
    new Date().toISOString(),
  );
  if (opts.withFile !== false) {
    const file = storagePath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(1024, 1));
  }
  return { projectId, sourceId, clipId, renderId };
}

export function addAccount(provider: Provider, id = `ext-${provider}`, tokens: { accessToken: string; refreshToken?: string; expiresAt?: string } = { accessToken: `AT-${provider}`, refreshToken: `RT-${provider}` }): SocialAccount {
  return upsertAccounts(provider, { tokens: { ...tokens, scopes: ["s"] }, accounts: [{ externalAccountId: id, displayName: `Acc ${provider}`, username: `u_${provider}`, meta: {} }] })[0]!;
}

export const ALL_PROVIDERS = PROVIDERS;

/** A scriptable publisher; override anything. validate() is permissive unless overridden. */
export function fakePublisher(provider: Provider, over: Partial<Publisher> = {}): Publisher {
  return {
    provider,
    limits: PLATFORM_LIMITS[provider],
    getAuthUrl: (_c, a) => `https://auth.example/${provider}?state=${encodeURIComponent(a.state)}`,
    connect: async () => ({ tokens: { accessToken: "AT-user", refreshToken: "RT-user", scopes: ["a", "b"] }, accounts: [{ externalAccountId: "ext-1", displayName: "One", meta: {} }] }),
    refresh: async (_c, t) => ({ ...t, accessToken: "AT-refreshed" }),
    validate: () => [],
    publish: async () => ({ externalId: `ext_${provider}_1`, status: "published", url: `https://example.invalid/${provider}/1` }),
    getStatus: async () => ({ status: "published", url: `https://example.invalid/${provider}/1` }),
    fetchMetrics: async () => ({ views: 10, likes: 1, comments: 0, shares: 0, raw: {} }),
    ...over,
  };
}
