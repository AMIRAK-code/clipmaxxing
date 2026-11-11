import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-web-test-"));
process.env.KLIPZ_DATA_DIR = tmp;

import { all, get, newId, openDb, run, setDb } from "./db";
import { applyClipPatch, ClipPatchSchema, deleteClip, MAX_CLIP_SEC, planClipPatch, wordsInRange } from "./clips";
import { HttpError } from "./http";
import { cancelJob, enqueueJob, getJob, jobsChangedSince, retryJob } from "./jobs";
import { storagePath } from "./paths";
import { getClip } from "./repo";

const MIGRATIONS = path.resolve(__dirname, "../../../../db/migrations");

const opened: { close(): void }[] = [];
function fresh() {
  const d = openDb(path.join(tmp, `t-${newId()}.db`), MIGRATIONS);
  opened.push(d);
  setDb(d);
}

function seed(): { projectId: string; sourceId: string; clipId: string } {
  const projectId = newId();
  const sourceId = newId();
  const clipId = newId();
  run("insert into projects (id, title) values (?, 'P')", projectId);
  run("insert into source_videos (id, project_id, origin, status, duration_sec) values (?, ?, 'upload', 'ready', 100)", sourceId, projectId);
  run(
    "insert into clips (id, project_id, source_video_id, start_sec, end_sec, score, crop_track) values (?, ?, ?, 10, 30, 80, ?)",
    clipId,
    projectId,
    sourceId,
    JSON.stringify({ version: 1, srcW: 1920, srcH: 1080, segments: [] }),
  );
  return { projectId, sourceId, clipId };
}

beforeAll(() => fs.mkdirSync(tmp, { recursive: true }));
afterAll(() => {
  setDb(undefined);
  for (const d of opened) d.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a WAL handle; the OS temp dir is cleaned later */
  }
});

describe("db migrations", () => {
  it("creates the schema and records the version", () => {
    fresh();
    const tables = all<{ name: string }>("select name from sqlite_master where type='table'").map((t) => t.name);
    for (const t of ["projects", "source_videos", "transcripts", "clips", "renders", "jobs", "posts", "settings"]) expect(tables).toContain(t);
    expect(Number(get<{ user_version: number }>("PRAGMA user_version")?.user_version)).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent when opened twice", () => {
    const file = path.join(tmp, "twice.db");
    openDb(file, MIGRATIONS).close();
    const again = openDb(file, MIGRATIONS);
    expect(again.prepare("select count(*) as n from projects").get()).toEqual({ n: 0 });
    again.close();
  });
});

describe("jobs", () => {
  beforeEach(fresh);

  it("dedupes while a job with the same key is live", () => {
    const a = enqueueJob("analyze", { x: 1 }, { dedupeKey: "analyze:s1" });
    const b = enqueueJob("analyze", { x: 2 }, { dedupeKey: "analyze:s1" });
    expect(b.id).toBe(a.id);
    run("update jobs set status = 'running' where id = ?", a.id);
    expect(enqueueJob("analyze", {}, { dedupeKey: "analyze:s1" }).id).toBe(a.id);
    run("update jobs set status = 'succeeded' where id = ?", a.id);
    expect(enqueueJob("analyze", {}, { dedupeKey: "analyze:s1" }).id).not.toBe(a.id);
  });

  it("does not dedupe without a key", () => {
    expect(enqueueJob("cleanup", {}).id).not.toBe(enqueueJob("cleanup", {}).id);
  });

  it("retryJob requeues failed jobs only", () => {
    const j = enqueueJob("analyze", {});
    expect(retryJob(j.id)).toBe(false);
    run("update jobs set status = 'dead', attempts = 3, error = 'boom' where id = ?", j.id);
    expect(retryJob(j.id)).toBe(true);
    const after = getJob(j.id)!;
    expect(after.status).toBe("queued");
    expect(after.attempts).toBe(0);
    expect(after.error).toBeNull();
  });

  it("cancelJob cancels active jobs only", () => {
    const j = enqueueJob("analyze", {});
    expect(cancelJob(j.id)).toBe(true);
    expect(getJob(j.id)!.status).toBe("cancelled");
    expect(cancelJob(j.id)).toBe(false);
  });

  it("jobsChangedSince returns only newer rows", () => {
    const a = enqueueJob("analyze", {});
    run("update jobs set updated_at = '2020-01-01T00:00:00.000Z' where id = ?", a.id);
    const b = enqueueJob("cleanup", {});
    const ids = jobsChangedSince("2021-01-01T00:00:00.000Z").map((j) => j.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(a.id);
  });
});

describe("clip patch planning", () => {
  const clip = { start_sec: 10, end_sec: 30, edit_version: 2 };

  it("clamps to the source duration and to zero", () => {
    const p = planClipPatch(clip, 100, { start_sec: -5, end_sec: 500 });
    expect(p.columns.start_sec).toBe(0);
    expect(p.columns.end_sec).toBe(100);
    expect(p.rangeChanged).toBe(true);
  });

  it("enforces 1 s minimum and 180 s maximum", () => {
    expect(() => planClipPatch(clip, 1000, { end_sec: 10.5 })).toThrow(HttpError);
    expect(() => planClipPatch(clip, 1000, { start_sec: 0, end_sec: MAX_CLIP_SEC + 1 })).toThrow(/at most/);
    expect(() => planClipPatch(clip, 1000, { start_sec: 0, end_sec: MAX_CLIP_SEC })).not.toThrow();
  });

  it("rejects a stale expected_version with 409", () => {
    try {
      planClipPatch(clip, 100, { edit_state: { version: 1 }, expected_version: 1 });
      expect.unreachable();
    } catch (e) {
      expect((e as HttpError).status).toBe(409);
    }
  });

  it("flags edit_state saves for a version bump and ignores no-op ranges", () => {
    const p = planClipPatch(clip, 100, { edit_state: { version: 1, a: 1 }, start_sec: 10, end_sec: 30, expected_version: 2 });
    expect(p.bumpVersion).toBe(true);
    expect(p.rangeChanged).toBe(false);
  });

  it("schema rejects unknown fields and bad status", () => {
    expect(ClipPatchSchema.safeParse({ nope: 1 }).success).toBe(false);
    expect(ClipPatchSchema.safeParse({ status: "weird" }).success).toBe(false);
    expect(ClipPatchSchema.safeParse({ status: "kept", start_sec: 1 }).success).toBe(true);
  });
});

describe("applyClipPatch", () => {
  beforeEach(fresh);

  it("changing the range clears crop_track and enqueues one reframe job", () => {
    const { clipId } = seed();
    const r = applyClipPatch(clipId, { start_sec: 12, end_sec: 35 });
    expect(r.reframeQueued).toBe(true);
    expect(r.clip.crop_track).toBeNull();
    expect(r.clip.start_sec).toBe(12);
    applyClipPatch(clipId, { start_sec: 13 });
    const jobs = all<{ type: string; dedupe_key: string }>("select type, dedupe_key from jobs where type = 'reframe'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.dedupe_key).toBe(`reframe:${clipId}`);
  });

  it("status-only changes keep the crop track and queue nothing", () => {
    const { clipId } = seed();
    const r = applyClipPatch(clipId, { status: "kept" });
    expect(r.reframeQueued).toBe(false);
    expect(r.clip.status).toBe("kept");
    expect(r.clip.crop_track).not.toBeNull();
    expect(all("select * from jobs")).toHaveLength(0);
  });

  it("edit_state saves bump edit_version and honour optimistic concurrency", () => {
    const { clipId } = seed();
    const a = applyClipPatch(clipId, { edit_state: { version: 1 }, expected_version: 0 });
    expect(a.clip.edit_version).toBe(1);
    expect(a.clip.edit_state).toEqual({ version: 1 });
    expect(() => applyClipPatch(clipId, { edit_state: { version: 1, extra: 2 }, expected_version: 0 })).toThrow(/changed elsewhere/);
    expect(getClip(clipId)!.edit_version).toBe(1);
  });

  it("404 for a missing clip", () => {
    expect(() => applyClipPatch(newId(), { status: "kept" })).toThrow(/not found/i);
  });

  it("deleteClip removes the row and its storage folder", () => {
    const { clipId } = seed();
    const dir = storagePath(`clips/${clipId}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "x.mp4"), "x");
    expect(deleteClip(clipId)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    expect(getClip(clipId)).toBeUndefined();
    expect(deleteClip(clipId)).toBe(false);
  });

  it("deleteClip cancels queued jobs for that clip only", () => {
    const { clipId, projectId } = seed();
    const mine = enqueueJob("reframe", { clip_id: clipId }, { projectId, dedupeKey: `reframe:${clipId}` });
    const other = enqueueJob("reframe", { clip_id: newId() }, { projectId, dedupeKey: `reframe:${newId()}` });
    deleteClip(clipId);
    expect(getJob(mine.id)?.status).toBe("cancelled");
    expect(getJob(other.id)?.status).toBe("queued");
  });
});

describe("wordsInRange", () => {
  it("keeps words overlapping the window", () => {
    const w = [
      { w: "a", s: 0, e: 1 },
      { w: "b", s: 1, e: 2 },
      { w: "c", s: 5, e: 6 },
    ];
    expect(wordsInRange(w, 0.5, 3).map((x) => x.w)).toEqual(["a", "b"]);
  });
});

describe("storagePath", () => {
  afterEach(() => undefined);
  it("resolves inside the storage dir", () => {
    expect(storagePath("sources/x/video.mp4").startsWith(path.join(tmp, "storage"))).toBe(true);
  });
  it("rejects traversal", () => {
    expect(() => storagePath("../secret.key")).toThrow(/Invalid storage key/);
    expect(() => storagePath("a/../../b")).toThrow(/Invalid storage key/);
    expect(() => storagePath("../storage-evil/x")).toThrow(/Invalid storage key/);
  });
});
