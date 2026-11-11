import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dbPath, repoRoot } from "./paths";

// One SQLite file shared with the Python worker. WAL lets the worker write
// while the web app reads; busy_timeout covers the brief write locks.

type Row = Record<string, unknown>;

const g = globalThis as unknown as { __klipzDb?: DatabaseSync };

export function openDb(file: string, migrationsDir: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  migrate(db, migrationsDir);
  return db;
}

/** Apply db/migrations/NNNN_*.sql files newer than PRAGMA user_version. */
export function migrate(db: DatabaseSync, migrationsDir: string): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const version = Number.parseInt(f, 10);
    if (version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check inside the lock: the worker may have migrated meanwhile.
      const now = Number((db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
      if (version > now) {
        db.exec(fs.readFileSync(path.join(migrationsDir, f), "utf8"));
        db.exec(`PRAGMA user_version = ${version}`);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

export function db(): DatabaseSync {
  if (!g.__klipzDb) g.__klipzDb = openDb(dbPath(), path.join(repoRoot(), "db", "migrations"));
  return g.__klipzDb;
}

/** Point the app at a specific database (tests). */
export function setDb(d: DatabaseSync | undefined): void {
  g.__klipzDb = d;
}

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

export function all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
  // node:sqlite rows have a null prototype, which React Server Components refuse to serialise.
  return db().prepare(sql).all(...params).map((r) => ({ ...r })) as T[];
}
export function get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
  const r = db().prepare(sql).get(...params);
  return r ? ({ ...r } as T) : undefined;
}
export function run(sql: string, ...params: SQLInputValue[]): { changes: number } {
  const r = db().prepare(sql).run(...params);
  return { changes: Number(r.changes) };
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    d.exec("COMMIT");
    return out;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/** Parse the JSON text columns of a row in place. */
export function parseJson<T>(row: Row | undefined, cols: string[]): T | undefined {
  if (!row) return undefined;
  const out: Row = { ...row };
  for (const c of cols) {
    const v = out[c];
    if (typeof v === "string") {
      try {
        out[c] = JSON.parse(v);
      } catch {
        out[c] = null;
      }
    }
  }
  return out as T;
}

export const JSON_COLS = {
  source_videos: ["scene_cuts", "energy"],
  transcripts: ["words", "segments", "speakers"],
  clips: ["score_breakdown", "crop_track", "edit_state"],
  renders: ["options"],
  social_accounts: ["scopes", "meta"],
  posts: ["hashtags", "options"],
  post_metrics: ["raw"],
  jobs: ["payload", "result"],
  caption_styles: ["style"],
} as const;

type Table = keyof typeof JSON_COLS;

export function rows<T>(table: Table, sql: string, ...params: SQLInputValue[]): T[] {
  return all(sql, ...params).map((r) => parseJson<T>(r, [...JSON_COLS[table]])!) as T[];
}
export function row<T>(table: Table, sql: string, ...params: SQLInputValue[]): T | undefined {
  return parseJson<T>(get(sql, ...params), [...JSON_COLS[table]]);
}

/**
 * Patch a row from a whitelist of columns. Objects/arrays are JSON-encoded.
 * Returns false when nothing matched.
 */
export function update(table: string, id: string, patch: Row, allowed: readonly string[]): boolean {
  const keys = Object.keys(patch).filter((k) => allowed.includes(k) && patch[k] !== undefined);
  if (keys.length === 0) return false;
  const vals = keys.map((k) => {
    const v = patch[k];
    if (v === null) return null;
    if (typeof v === "object") return JSON.stringify(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    return v as SQLInputValue;
  });
  const hasUpdated = ["projects", "clips", "posts", "social_accounts", "jobs"].includes(table);
  const sets = keys.map((k) => `${k} = ?`).concat(hasUpdated ? ["updated_at = ?"] : []);
  const r = run(`update ${table} set ${sets.join(", ")} where id = ?`, ...vals, ...(hasUpdated ? [nowIso()] : []), id);
  return r.changes > 0;
}
