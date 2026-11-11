import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-renders-test-"));
process.env.KLIPZ_DATA_DIR = tmp;

import { get, newId, openDb, run, setDb } from "./db";
import { HttpError } from "./http";
import { getJob } from "./jobs";
import { applyClipPatch } from "./clips";
import { createRender, filterFileIssues, platformChecks, renderViews } from "./renders";

const MIGRATIONS = path.resolve(__dirname, "../../../../db/migrations");
const dbs: { close(): void }[] = [];

function fresh() {
  const d = openDb(path.join(tmp, `r-${newId()}.db`), MIGRATIONS);
  dbs.push(d);
  setDb(d);
  const projectId = newId();
  const sourceId = newId();
  const clipId = newId();
  run("insert into projects (id, title) values (?, 'P')", projectId);
  run("insert into source_videos (id, project_id, origin, status, duration_sec) values (?, ?, 'upload', 'ready', 100)", sourceId, projectId);
  run("insert into clips (id, project_id, source_video_id, start_sec, end_sec) values (?, ?, ?, 10, 30)", clipId, projectId, sourceId);
  return { projectId, clipId };
}

afterAll(() => {
  setDb(undefined);
  for (const d of dbs) d.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may keep a WAL handle */
  }
});

const edit = { version: 1 as const, video: [] };

describe("createRender", () => {
  it("creates a queued render stamped with the clip's edit_version and a render job", () => {
    const { clipId, projectId } = fresh();
    applyClipPatch(clipId, { edit_state: edit, expected_version: 0 });
    const { render, job, reused } = createRender(clipId, { denoise: true });
    expect(reused).toBe(false);
    expect(render).toMatchObject({ clip_id: clipId, status: "queued", edit_version: 1 });
    expect((render as unknown as { options: unknown }).options).toEqual({ denoise: true });
    expect(job).toMatchObject({ type: "render", status: "queued", project_id: projectId, dedupe_key: `render:${render.id}` });
    expect(job!.payload).toEqual({ render_id: render.id });
    expect(getJob(job!.id)?.payload).toEqual({ render_id: render.id });
  });

  it("returns the in-flight render for the same edit_version instead of making another", () => {
    const { clipId } = fresh();
    applyClipPatch(clipId, { edit_state: edit, expected_version: 0 });
    const a = createRender(clipId);
    const b = createRender(clipId);
    expect(b.reused).toBe(true);
    expect(b.render.id).toBe(a.render.id);
    expect(b.job!.id).toBe(a.job!.id);
    expect(get<{ n: number }>("select count(*) as n from renders")?.n).toBe(1);
    expect(get<{ n: number }>("select count(*) as n from jobs where type = 'render'")?.n).toBe(1);
    // also while it is rendering
    run("update renders set status = 'rendering' where id = ?", a.render.id);
    expect(createRender(clipId).render.id).toBe(a.render.id);
  });

  it("starts a new render when the edit moved on, or the options differ, or the old one finished", () => {
    const { clipId } = fresh();
    applyClipPatch(clipId, { edit_state: edit, expected_version: 0 });
    const a = createRender(clipId);
    expect(createRender(clipId, { denoise: true }).render.id).not.toBe(a.render.id);
    applyClipPatch(clipId, { edit_state: { ...edit, video: [] }, expected_version: 1 });
    const c = createRender(clipId);
    expect(c.reused).toBe(false);
    expect(c.render.edit_version).toBe(2);
    run("update renders set status = 'ready' where id = ?", c.render.id);
    expect(createRender(clipId).render.id).not.toBe(c.render.id);
  });

  it("404 for a missing clip", () => {
    fresh();
    expect(() => createRender(newId())).toThrow(HttpError);
  });
});

describe("renderViews / platform checks", () => {
  it("flags outdated renders and omits platform checks until ready", () => {
    const { clipId } = fresh();
    applyClipPatch(clipId, { edit_state: edit, expected_version: 0 });
    const { render } = createRender(clipId);
    let v = renderViews(clipId);
    expect(v[0]).toMatchObject({ id: render.id, outdated: false, platforms: null });
    applyClipPatch(clipId, { edit_state: edit, expected_version: 1 });
    v = renderViews(clipId);
    expect(v[0]!.outdated).toBe(true);
  });

  it("validates a ready render per platform and ignores caption/options issues", () => {
    const { clipId } = fresh();
    const id = newId();
    run(
      `insert into renders (id, clip_id, status, storage_key, width, height, fps, duration_sec, size_bytes, video_codec, audio_codec, edit_version)
       values (?, ?, 'ready', 'clips/x/out.mp4', 1080, 1920, 30, 45, 20000000, 'h264', 'aac', 0)`,
      id,
      clipId,
    );
    const view = renderViews(clipId)[0]!;
    expect(view.platforms).toHaveLength(6);
    const by = Object.fromEntries(view.platforms!.map((p) => [p.provider, p]));
    expect(by.youtube!.ok).toBe(true);
    expect(by.tiktok!.ok).toBe(true);
    expect(by.x!.ok).toBe(true);
  });

  it("reports the specific blocking issue when the file breaks a limit", () => {
    const checks = platformChecks({
      filePath: path.join(tmp, "out.mp4"),
      sizeBytes: 20_000_000,
      durationSec: 400,
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      mimeType: "video/mp4",
    });
    const by = Object.fromEntries(checks.map((c) => [c.provider, c]));
    expect(by.youtube!.ok).toBe(false);
    expect(by.youtube!.errors.join(" ")).toMatch(/180|duration|long/i);
    expect(by.facebook!.ok).toBe(false);
    expect(by.x!.ok).toBe(false); // 140 s cap
    expect(by.tiktok!.ok).toBe(true);
  });

  it("filterFileIssues drops caption/title/hashtag/option issues", () => {
    const out = filterFileIssues([
      { field: "caption", code: "x", message: "caption missing", severity: "error" },
      { field: "options.privacy", code: "x", message: "privacy", severity: "error" },
      { field: "render.durationSec", code: "x", message: "too long", severity: "error" },
    ]);
    expect(out.map((i) => i.field)).toEqual(["render.durationSec"]);
  });
});
