import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { all } from "./db";
import { HttpError } from "./http";
import { dataDir, storageDir, storagePath } from "./paths";

// The Library: a folder a person can actually browse.
//
// KLIPZ keeps media under <data dir>\storage\<kind>\<uuid>\..., which is right for the app and useless in
// Explorer. So <data dir>\Library mirrors it with real names:
//
//   Library\Raw videos\<video title>.mp4          every imported / downloaded source video
//   Library\Clips\<project>\<clip title>.mp4      the latest finished render of every clip
//
// The entries are hard links (same file, no extra disk space, no copying). A small manifest records which
// links KLIPZ made, so it only ever removes its own.

export const LIBRARY_DIR = "Library";
export const RAW_DIR = "Raw videos";
export const CLIPS_DIR = "Clips";
const MANIFEST = ".klipz-links.json";

export interface LibraryItem {
  kind: "raw" | "clip";
  /** source_videos.id or renders.id */
  id: string;
  title: string;
  project: string;
  /** absolute path to show / open (the Library link, or the stored file if linking failed) */
  path: string;
  /** storage key for previews via /api/files */
  key: string;
  thumbKey: string | null;
  sizeBytes: number;
  durationSec: number | null;
  createdAt: string;
  origin?: "upload" | "youtube";
  clipId?: string;
}

export interface LibraryOverview {
  folders: { library: string; raw: string; clips: string };
  raw: LibraryItem[];
  clips: LibraryItem[];
  totalBytes: number;
  canReveal: boolean;
}

/** A file name Windows accepts: no reserved characters, no trailing dot/space, not a device name. */
export function safeName(name: string, fallback: string): string {
  let s = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (s.length > 110) s = s.slice(0, 110).trim().replace(/[. ]+$/g, "");
  if (!s || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = fallback;
  return s;
}

interface Wanted {
  rel: string;
  key: string;
  item: Omit<LibraryItem, "path">;
}

interface RawRow {
  id: string;
  storage_key: string;
  filename: string | null;
  size_bytes: number | null;
  duration_sec: number | null;
  origin: "upload" | "youtube";
  created_at: string;
  project_title: string | null;
}

interface ClipRow {
  render_id: string;
  clip_id: string;
  storage_key: string;
  cover_key: string | null;
  size_bytes: number | null;
  duration_sec: number | null;
  completed_at: string | null;
  created_at: string;
  clip_title: string | null;
  project_title: string | null;
}

/** What the Library should contain, with unique relative paths (pure given the rows). */
export function planLibrary(raws: RawRow[], clips: ClipRow[]): Wanted[] {
  const used = new Set<string>();
  const unique = (dir: string, base: string, ext: string, id: string): string => {
    let rel = path.join(dir, `${base}${ext}`);
    if (used.has(rel.toLowerCase())) rel = path.join(dir, `${base} [${id.slice(0, 6)}]${ext}`);
    used.add(rel.toLowerCase());
    return rel;
  };
  const out: Wanted[] = [];
  for (const r of raws) {
    const ext = path.extname(r.storage_key) || ".mp4";
    const title = (r.filename ?? "").replace(/\.(mp4|mov|mkv|webm|m4v|avi)$/i, "") || "Video";
    const base = safeName(title, "Video");
    out.push({
      rel: unique(RAW_DIR, base, ext, r.id),
      key: r.storage_key,
      item: {
        kind: "raw", id: r.id, title, project: r.project_title ?? "", key: r.storage_key,
        thumbKey: `${path.posix.dirname(r.storage_key)}/thumb.jpg`, sizeBytes: r.size_bytes ?? 0, durationSec: r.duration_sec,
        createdAt: r.created_at, origin: r.origin,
      },
    });
  }
  for (const c of clips) {
    const title = c.clip_title?.trim() || "Clip";
    const project = c.project_title?.trim() || "Project";
    out.push({
      rel: unique(path.join(CLIPS_DIR, safeName(project, "Project")), safeName(title, "Clip"), path.extname(c.storage_key) || ".mp4", c.render_id),
      key: c.storage_key,
      item: {
        kind: "clip", id: c.render_id, clipId: c.clip_id, title, project, key: c.storage_key, thumbKey: c.cover_key,
        sizeBytes: c.size_bytes ?? 0, durationSec: c.duration_sec, createdAt: c.completed_at ?? c.created_at,
      },
    });
  }
  return out;
}

function readManifest(root: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const sameFile = (a: string, b: string): boolean => {
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino === sb.ino && sa.dev === sb.dev && sa.size === sb.size;
  } catch {
    return false;
  }
};

function rows(): { raws: RawRow[]; clips: ClipRow[] } {
  const raws = all<RawRow>(
    `select s.id, s.storage_key, s.filename, s.size_bytes, s.duration_sec, s.origin, s.created_at, p.title as project_title
       from source_videos s left join projects p on p.id = s.project_id
      where s.storage_key is not null and s.status != 'deleted' order by s.created_at desc`,
  );
  // the newest finished render of each clip
  const clips = all<ClipRow>(
    `select r.id as render_id, r.clip_id, r.storage_key, r.cover_key, r.size_bytes, r.duration_sec, r.completed_at, r.created_at,
            c.title as clip_title, p.title as project_title
       from renders r join clips c on c.id = r.clip_id left join projects p on p.id = c.project_id
      where r.status = 'ready' and r.storage_key is not null
        and r.created_at = (select max(r2.created_at) from renders r2 where r2.clip_id = r.clip_id and r2.status = 'ready' and r2.storage_key is not null)
      order by coalesce(r.completed_at, r.created_at) desc`,
  );
  return { raws, clips };
}

/** Bring <data dir>\Library in line with the database and return what is in it. */
export function syncLibrary(): LibraryOverview {
  const root = path.join(dataDir(), LIBRARY_DIR);
  const rawDir = path.join(root, RAW_DIR);
  const clipsDir = path.join(root, CLIPS_DIR);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(clipsDir, { recursive: true });

  const { raws, clips } = rows();
  const wanted = planLibrary(raws, clips);
  const before = readManifest(root);
  const after: Record<string, string> = {};
  const items: LibraryItem[] = [];

  for (const w of wanted) {
    let src: string;
    try {
      src = storagePath(w.key);
    } catch {
      continue;
    }
    let size: number;
    try {
      size = fs.statSync(src).size;
    } catch {
      continue; // file is gone (cleaned up): not in the Library
    }
    const dest = path.join(root, w.rel);
    let shown = dest;
    try {
      if (!sameFile(src, dest)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // Only replace something we created ourselves (or nothing); never a file the person put there.
        if (fs.existsSync(dest) && before[w.rel] === undefined) throw new Error("name taken by a foreign file");
        fs.rmSync(dest, { force: true });
        fs.linkSync(src, dest);
      }
      after[w.rel] = w.key;
    } catch {
      shown = src; // linking not possible (other volume, name taken): point at the stored file instead
    }
    items.push({ ...w.item, sizeBytes: w.item.sizeBytes || size, path: shown });
  }

  // remove links we made earlier that are no longer wanted, then empty project folders
  for (const rel of Object.keys(before)) {
    if (after[rel] !== undefined) continue;
    const p = path.resolve(root, rel);
    if (!p.startsWith(root + path.sep)) continue;
    fs.rmSync(p, { force: true });
    try {
      const dir = path.dirname(p);
      if (dir !== rawDir && dir !== clipsDir && dir.startsWith(clipsDir + path.sep) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* not empty or already gone */
    }
  }
  try {
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(after, null, 2));
  } catch {
    /* read-only data dir: links simply get rebuilt next time */
  }

  return {
    folders: { library: root, raw: rawDir, clips: clipsDir },
    raw: items.filter((i) => i.kind === "raw"),
    clips: items.filter((i) => i.kind === "clip"),
    totalBytes: items.reduce((n, i) => n + i.sizeBytes, 0),
    canReveal: process.platform === "win32",
  };
}

// ── actions ──────────────────────────────────────────────────────────────

export type LibraryAction = "reveal" | "open" | "copy";
export type LibraryTarget = { kind: "raw" | "clip"; id: string } | { kind: "folder"; id: "library" | "raw" | "clips" };

/** Absolute path of a target. Only paths KLIPZ itself derived from the database are ever returned. */
export function resolveTarget(target: LibraryTarget): { path: string; isFolder: boolean } {
  const lib = syncLibrary();
  if (target.kind === "folder") {
    const p = lib.folders[target.id];
    if (!p) throw new HttpError(400, "Unknown folder");
    return { path: p, isFolder: true };
  }
  const item = (target.kind === "raw" ? lib.raw : lib.clips).find((i) => i.id === target.id);
  if (!item) throw new HttpError(404, "That file is no longer in the library");
  const root = path.join(dataDir(), LIBRARY_DIR);
  const store = storageDir();
  if (!item.path.startsWith(root + path.sep) && !item.path.startsWith(store + path.sep)) throw new HttpError(400, "Unexpected path");
  return { path: item.path, isFolder: false };
}

function launch(exe: string, args: string[], opts: { verbatim?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: opts.verbatim ?? false, ...(opts.env ? { env: opts.env } : {}) });
    child.once("error", (e) => reject(new HttpError(500, `Could not start ${exe}: ${e.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Run a desktop action on a library file or folder. Windows only (the desktop app). */
export async function runLibraryAction(action: LibraryAction, target: LibraryTarget): Promise<{ path: string }> {
  if (process.platform !== "win32") throw new HttpError(501, "Only available in the Windows app");
  const { path: p, isFolder } = resolveTarget(target);
  if (p.includes('"')) throw new HttpError(400, "Unexpected path");
  if (action === "reveal") {
    // explorer wants: /select,"C:\full path\file.mp4" as one argument, quotes around the path only
    await (isFolder ? launch("explorer.exe", [p]) : launch("explorer.exe", [`/select,"${p}"`], { verbatim: true }));
  } else if (action === "open") {
    await launch("explorer.exe", [p]); // a file opens in its default app, a folder in Explorer
  } else {
    if (isFolder) throw new HttpError(400, "Choose a file to copy");
    // Puts the FILE on the clipboard (not its text path): paste into WhatsApp, Telegram, Discord, mail, Explorer.
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard -LiteralPath $env:KLIPZ_CLIP_PATH"], {
        stdio: "ignore", windowsHide: true, env: { ...process.env, KLIPZ_CLIP_PATH: p },
      });
      child.once("error", (e) => reject(new HttpError(500, `Could not copy: ${e.message}`)));
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new HttpError(500, "Could not copy the file to the clipboard"))));
    });
  }
  return { path: p };
}
