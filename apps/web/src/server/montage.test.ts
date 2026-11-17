import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-montage-test-"));
process.env.KLIPZ_DATA_DIR = tmp;

import type { Clip, EditState } from "@klipz/shared";
import { totalDuration } from "@klipz/shared";
import { all, get, newId, openDb, run, setDb } from "./db";
import { clipDetail } from "./clips";
import { HttpError } from "./http";
import {
  assembleMontages,
  createMontageProject,
  listMontageProjects,
  makeMoreMontages,
  montageDetail,
  mulberry32,
  normalizeSettings,
  remixMontage,
  startMontage,
  type AssemblyScene,
} from "./montage";
import { createProject, listProjects } from "./repo";

const MIGRATIONS = path.resolve(__dirname, "../../../../db/migrations");
const FIXTURE = path.resolve(__dirname, "../../../worker/tests/fixtures/montage_assembly.json");

const opened: { close(): void }[] = [];
beforeEach(() => {
  const d = openDb(path.join(tmp, `t-${newId()}.db`), MIGRATIONS);
  opened.push(d);
  setDb(d);
});
afterAll(() => {
  setDb(undefined);
  for (const d of opened) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("assembly (same as the worker's)", () => {
  it("mulberry32 gives the reference values", () => {
    const r = mulberry32(42);
    // the same values tests/test_montage.py checks for the Python port
    for (const v of [0.601103751920164, 0.448290558997542, 0.85246579349041, 0.669734041439369]) expect(r()).toBeCloseTo(v, 14);
  });

  it("matches the Python assembly for the shared fixture", () => {
    const cases = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Array<{
      name: string;
      scenes: AssemblyScene[];
      count: number;
      minSec: number;
      maxSec: number;
      seed: number;
      usage?: Record<string, number>;
      expected: unknown;
    }>;
    expect(cases.length).toBeGreaterThan(2);
    for (const c of cases) expect(assembleMontages(c.scenes, c.count, c.minSec, c.maxSec, c.seed, c.usage), c.name).toEqual(c.expected);
  });

  it("never makes a montage longer than the maximum", () => {
    const scenes: AssemblyScene[] = [
      { id: "a", input: "A", start: 0, end: 4.5, score: 50 },
      { id: "b", input: "B", start: 6, end: 9, score: 70 },
      { id: "c", input: "A", start: 12, end: 14.2, score: 20 },
    ];
    for (let seed = 1; seed < 150; seed++) {
      for (const pieces of assembleMontages(scenes, 3, 5, 7, seed)) {
        expect(pieces.reduce((a, p) => a + p.srcEnd - p.srcStart, 0)).toBeLessThanOrEqual(7 + 1e-6);
      }
    }
  });

  it("normalizes settings into the allowed ranges", () => {
    expect(normalizeSettings({ count: 99, minSec: 40, maxSec: 2 })).toEqual({ count: 20, minSec: 5, maxSec: 40 });
    expect(normalizeSettings(null)).toEqual({ count: 5, minSec: 10, maxSec: 20 });
  });
});

/** A montage project as the worker leaves it: inputs, a pool with scenes and transcript, no clips yet. */
function seedPool() {
  const project = createMontageProject("Trip", { count: 3, minSec: 6, maxSec: 9 });
  const inputs = ["a.mp4", "b.mp4"].map((filename) => {
    const id = newId();
    run("insert into source_videos (id, project_id, origin, filename, status, role) values (?, ?, 'upload', ?, 'ready', 'input')", id, project.id, filename);
    return id;
  });
  const pool = newId();
  run(
    "insert into source_videos (id, project_id, origin, status, role, storage_key, duration_sec, width, height, fps) values (?, ?, 'upload', 'ready', 'pool', ?, 40, 1080, 1920, 30)",
    pool,
    project.id,
    `sources/${pool}/source.mp4`,
  );
  const words = [
    { w: "look", s: 1.2, e: 1.5 },
    { w: "at", s: 1.6, e: 1.7 },
    { w: "this!", s: 1.8, e: 2.2 },
    { w: "wow", s: 21.5, e: 21.9 },
  ];
  run("insert into transcripts (id, source_video_id, words) values (?, ?, ?)", newId(), pool, JSON.stringify(words));
  // [pool_min, pool_start, pool_end, pool_max, input index]
  const spans: [number, number, number, number, number][] = [
    [0, 1, 4, 5, 0],
    [5, 6, 9, 10, 1],
    [10, 11, 14.5, 15.5, 0],
    [15.5, 16.5, 19, 20, 1],
    [20, 21, 24, 25, 0],
    [25, 26, 29.5, 30.5, 1],
  ];
  spans.forEach(([mn, s, e, mx, inp], idx) => {
    run(
      `insert into montage_scenes (id, project_id, input_source_id, pool_source_id, idx, src_start, src_end, pool_start, pool_end, pool_min, pool_max,
         score, has_speech, text, input_name) values (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      project.id,
      inputs[inp]!,
      pool,
      idx,
      s,
      e,
      mn,
      mx,
      50 + idx,
      idx === 0 ? 1 : 0,
      idx === 0 ? "look at this!" : null,
      inp ? "b.mp4" : "a.mp4",
    );
  });
  return { project, inputs, pool };
}

describe("montage projects", () => {
  it("are listed apart from clip projects", () => {
    createProject("Ordinary");
    const m = createMontageProject("Mix", { count: 2 });
    expect(listProjects().map((p) => p.title)).toEqual(["Ordinary"]);
    const listed = listMontageProjects();
    expect(listed.map((p) => p.id)).toEqual([m.id]);
    expect(listed[0]).toMatchObject({ kind: "montage", settings: { count: 2, minSec: 10, maxSec: 20 }, inputs: 0, montage_count: 0, pool: null });
  });

  it("start needs finished uploads and queues one montage job", () => {
    const p = createMontageProject("Mix", {});
    expect(() => startMontage(p.id)).toThrow(HttpError);
    const sid = newId();
    run("insert into source_videos (id, project_id, origin, status) values (?, ?, 'upload', 'uploading')", sid, p.id);
    expect(() => startMontage(p.id)).toThrow(/upload/);
    run("update source_videos set status = 'pending' where id = ?", sid);
    const job = startMontage(p.id);
    expect(job).toMatchObject({ type: "montage", payload: { project_id: p.id } });
    expect(startMontage(p.id).id).toBe(job.id); // idempotent while it runs
  });

  it("make more adds montages from the pool, each with a queued render", () => {
    const { project, pool } = seedPool();
    const made = makeMoreMontages(project.id, 3);
    expect(made).toHaveLength(3);
    for (const c of made) {
      const edit = c.edit_state as EditState;
      expect(c.source_video_id).toBe(pool);
      expect(c.title).toMatch(/^Montage \d$/);
      expect(edit.captions.enabled).toBe(false);
      expect(totalDuration(edit.video)).toBeLessThanOrEqual(9 + 1e-6);
      expect(totalDuration(edit.video)).toBeGreaterThan(4);
    }
    expect(all("select * from renders where status = 'queued'")).toHaveLength(3);
    expect(all("select * from jobs where type = 'render'")).toHaveLength(3);
    const d = montageDetail(project.id);
    expect(d.montages).toHaveLength(3);
    expect(d.scenes).toHaveLength(6);
  });

  it("a new mix replaces the scenes but keeps captions, hook and volume, and re-renders", () => {
    const { project } = seedPool();
    const [m] = makeMoreMontages(project.id, 1);
    const edit = m!.edit_state as EditState;
    run(
      "update clips set edit_state = ? where id = ?",
      JSON.stringify({ ...edit, captions: { ...edit.captions, enabled: true }, hook: { ...edit.hook, enabled: true, text: "Mine" }, volume: 0 }),
      m!.id,
    );
    let changed = false;
    for (let i = 0; i < 6 && !changed; i++) {
      const r = remixMontage(m!.id) as Clip;
      const e = r.edit_state as EditState;
      expect(e.captions.enabled).toBe(true);
      expect(e.hook).toMatchObject({ enabled: true, text: "Mine" });
      expect(e.volume).toBe(0);
      changed = JSON.stringify(e.video.map((p) => p.srcStart)) !== JSON.stringify(edit.video.map((p) => p.srcStart));
    }
    expect(changed).toBe(true);
    expect(get<{ v: number }>("select edit_version as v from clips where id = ?", m!.id)!.v).toBeGreaterThan(0);
  });

  it("the editor gets the pool's scenes for a montage clip, nothing for an ordinary clip", () => {
    const { project } = seedPool();
    const [m] = makeMoreMontages(project.id, 1);
    const d = clipDetail(m!.id)!;
    expect(d.montage?.scenes).toHaveLength(6);
    expect(d.words.map((w) => w.w)).toContain("wow"); // every pool word, for added scenes
  });
});
