import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { all, db, get, run } from "./db";
import { dataDir, dbPath, repoRoot, storageDir } from "./paths";

// ── delete everything ───────────────────────────────────────────────────

/** Tables that survive "delete all my data" (schema bookkeeping the worker relies on). */
const KEEP_TABLES = new Set<string>(["settings"]);

export interface WipeResult {
  accountsDisconnected: number;
  rowsDeleted: Record<string, number>;
  storageEntriesRemoved: number;
}

/**
 * Single-user equivalent of account deletion: disconnects every social
 * account (drops stored tokens), empties every table and removes everything in
 * <data dir>/storage. The database file, schema, local secret keys and the
 * logs folder are kept so the app stays runnable. Platform-side revocation of
 * tokens is not possible without calling the platforms; posts that already
 * went out stay on the platforms.
 */
export function deleteAllData(): WipeResult {
  const d = db();
  const tables = all<{ name: string }>("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").map((r) => r.name);
  const accountsDisconnected = Number(get<{ n: number }>("select count(*) as n from social_accounts")?.n ?? 0);
  const rowsDeleted: Record<string, number> = {};
  d.exec("PRAGMA foreign_keys = OFF");
  try {
    d.exec("BEGIN IMMEDIATE");
    try {
      for (const t of tables) {
        if (KEEP_TABLES.has(t)) continue;
        rowsDeleted[t] = run(`delete from "${t.replace(/"/g, '""')}"`).changes;
      }
      // Keep only the worker heartbeat in settings; everything else is user data.
      rowsDeleted.settings = run("delete from settings where key <> 'worker_heartbeat'").changes;
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  } finally {
    d.exec("PRAGMA foreign_keys = ON");
  }
  const root = storageDir();
  let removed = 0;
  for (const name of fs.readdirSync(root)) {
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      removed++;
    } catch {
      /* a file the worker still holds open: reported below via count */
    }
  }
  try {
    d.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    /* best effort */
  }
  return { accountsDisconnected, rowsDeleted, storageEntriesRemoved: removed };
}

/** Delete every connected account (tokens go with the rows). Post history stays, with the account unlinked. */
export function disconnectAllAccounts(): number {
  return run("delete from social_accounts").changes;
}

// ── system status ───────────────────────────────────────────────────────

export function dirSize(dir: string, limit = 200_000): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < limit) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          bytes += fs.statSync(p).size;
          files++;
        } catch {
          /* vanished */
        }
      }
    }
  }
  return { bytes, files };
}

/** Names (never values) of keys that are non-empty in the environment or the repo-root / web .env.local files. */
export function keysPresent(names: string[], env: Record<string, string | undefined> = process.env, files: string[] = envFiles()): Record<string, boolean> {
  const fromFiles = new Set<string>();
  for (const f of files) {
    try {
      for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (m && m[2] && !/^(['"])\1$/.test(m[2])) fromFiles.add(m[1]!);
      }
    } catch {
      /* file absent */
    }
  }
  return Object.fromEntries(names.map((n) => [n, Boolean(env[n]?.trim()) || fromFiles.has(n)]));
}

function envFiles(): string[] {
  try {
    const root = repoRoot();
    return [path.join(root, ".env.local"), path.join(root, ".env"), path.join(root, "apps", "web", ".env.local")];
  } catch {
    return [];
  }
}

let ffmpegCache: { at: number; value: ToolInfo } | undefined;
export interface ToolInfo {
  ok: boolean;
  version?: string;
  path?: string;
}

function tryVersion(bin: string): string | undefined {
  const r = spawnSync(bin, ["-version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (r.status !== 0 || !r.stdout) return undefined;
  return /version\s+(\S+)/.exec(r.stdout.split("\n")[0] ?? "")?.[1] ?? "unknown";
}

function findStaticFfmpeg(): string | undefined {
  const venv = process.env.KLIPZ_VENV || path.join(os.homedir(), ".klipz", "venv");
  const base = path.join(venv, "Lib", "site-packages", "static_ffmpeg", "bin");
  const base2 = path.join(venv, "lib");
  for (const root of [base, base2]) {
    const stack = [root];
    let guard = 0;
    while (stack.length && guard++ < 200) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/^ffmpeg(\.exe)?$/.test(e.name)) return p;
      }
    }
  }
  return undefined;
}

export function ffmpegInfo(): ToolInfo {
  if (ffmpegCache && Date.now() - ffmpegCache.at < 60_000) return ffmpegCache.value;
  const candidates = [process.env.FFMPEG_PATH?.trim(), findStaticFfmpeg(), "ffmpeg"].filter((x): x is string => Boolean(x));
  let value: ToolInfo = { ok: false };
  for (const c of candidates) {
    const v = tryVersion(c);
    if (v) {
      value = { ok: true, version: v, path: c };
      break;
    }
  }
  ffmpegCache = { at: Date.now(), value };
  return value;
}

export interface SystemStatus {
  worker: { online: boolean; handlers: string[]; currentJob: { id: string; type: string } | null; error?: string; heartbeatAgeSec: number | null };
  node: string;
  ffmpeg: ToolInfo;
  dataDir: string;
  storage: { bytes: number; files: number };
  dbBytes: number;
  logBytes: number;
  llmScorer: string;
  keys: Record<string, boolean>;
  sandbox: boolean;
}

const OPTIONAL_KEYS = ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY", "AGGREGATOR_API_KEY", "TOKEN_ENCRYPTION_KEY", "OAUTH_STATE_SECRET", "OLLAMA_MODEL", "LLM_PROVIDER"];

/** Which scorer the worker will use, derived from the same env the worker reads. */
export function llmScorerLabel(keys: Record<string, boolean>, env: Record<string, string | undefined> = process.env): string {
  const provider = (env.LLM_PROVIDER ?? "auto").toLowerCase();
  if (provider === "none") return "Heuristic only (LLM_PROVIDER=none)";
  if (provider === "ollama") return keys.OLLAMA_MODEL ? "Ollama (local)" : "Heuristic (Ollama selected but OLLAMA_MODEL is not set)";
  if (keys.ANTHROPIC_API_KEY && provider !== "ollama") return "Claude (Anthropic API)";
  if (keys.OLLAMA_MODEL) return "Ollama (local)";
  return "Heuristic (no LLM key set)";
}

export async function systemStatus(fetchImpl: typeof fetch = fetch): Promise<SystemStatus> {
  const worker: SystemStatus["worker"] = { online: false, handlers: [], currentJob: null, heartbeatAgeSec: null };
  try {
    const res = await fetchImpl("http://127.0.0.1:8787/health", { signal: AbortSignal.timeout(1500), cache: "no-store" });
    if (res.ok) {
      const j = (await res.json()) as { ok?: boolean; handlers?: string[]; current_job?: { id: string; type: string } | null };
      worker.online = j.ok !== false;
      worker.handlers = Array.isArray(j.handlers) ? j.handlers : [];
      worker.currentJob = j.current_job ? { id: j.current_job.id, type: j.current_job.type } : null;
    } else worker.error = `Health check returned HTTP ${res.status}`;
  } catch (e) {
    worker.error = e instanceof Error && e.name !== "TimeoutError" ? e.message : "No answer on 127.0.0.1:8787";
  }
  const hb = get<{ value: string }>("select value from settings where key = 'worker_heartbeat'");
  if (hb) worker.heartbeatAgeSec = Math.max(0, Math.round((Date.now() - Date.parse(hb.value)) / 1000));
  // The heartbeat in the DB is what the worker writes even when its HTTP API is disabled.
  if (!worker.online && worker.heartbeatAgeSec !== null && worker.heartbeatAgeSec < 15) worker.online = true;

  const keys = keysPresent(OPTIONAL_KEYS);
  const dir = dataDir();
  let dbBytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      dbBytes += fs.statSync(dbPath() + suffix).size;
    } catch {
      /* absent */
    }
  }
  let logBytes = 0;
  try {
    for (const f of ["web.log", "web.log.1"]) {
      try {
        logBytes += fs.statSync(path.join(dir, "logs", f)).size;
      } catch {
        /* absent */
      }
    }
  } catch {
    /* ignore */
  }
  return {
    worker,
    node: process.version,
    ffmpeg: ffmpegInfo(),
    dataDir: dir,
    storage: dirSize(storageDir()),
    dbBytes,
    logBytes,
    llmScorer: llmScorerLabel(keys),
    keys,
    sandbox: /^(1|true|yes|on)$/i.test(process.env.KLIPZ_PUBLISH_MOCK?.trim() ?? ""),
  };
}
