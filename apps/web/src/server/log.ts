import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths";

/**
 * Small local error log (the replacement for hosted error tracking):
 * <data dir>/logs/web.log, rotated to web.log.1 once it passes ~5 MB.
 */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export const logDir = (dir: string = dataDir()): string => path.join(dir, "logs");
export const logFile = (dir: string = dataDir()): string => path.join(logDir(dir), "web.log");

function describe(e: unknown): string {
  if (e instanceof Error) return (e.stack ?? `${e.name}: ${e.message}`).slice(0, 4000);
  try {
    return typeof e === "string" ? e.slice(0, 4000) : JSON.stringify(e).slice(0, 4000);
  } catch {
    return String(e).slice(0, 4000);
  }
}

/** Append one entry. Never throws (logging must not break a request). */
export function logError(scope: string, e: unknown, opts: { dir?: string; maxBytes?: number; now?: Date } = {}): void {
  try {
    const dir = opts.dir ?? dataDir();
    const file = logFile(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const max = opts.maxBytes ?? MAX_LOG_BYTES;
    try {
      if (fs.statSync(file).size >= max) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* no file yet */
    }
    const line = `${(opts.now ?? new Date()).toISOString()} [${scope}] ${describe(e).replace(/\r?\n/g, "\n    ")}\n`;
    fs.appendFileSync(file, line);
  } catch {
    /* ignore */
  }
}

/** Last `lines` lines of the log (for the settings page). */
export function readLogTail(lines = 50, dir: string = dataDir()): string[] {
  try {
    const text = fs.readFileSync(logFile(dir), "utf8");
    return text.split("\n").filter(Boolean).slice(-lines);
  } catch {
    return [];
  }
}
