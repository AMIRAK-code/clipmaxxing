import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EditState, MontageScene, Project, SourceVideo } from "@klipz/shared";
import { produce } from "immer";
import { afterAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-montage-"));
process.env.KLIPZ_DATA_DIR = tmp;

import { GET as getProject } from "@/app/api/projects/[id]/route";
import { GET as listMontages, POST as createMontage } from "@/app/api/montages/route";
import { POST as buildMontage } from "@/app/api/montages/[id]/route";
import { POST as startUpload } from "@/app/api/uploads/route";
import { addScene, isMuted, moveScene, sceneOfPiece, setMuted } from "@/lib/montage";
import { all, db, run, setDb } from "./db";
import { listProjects } from "./repo";

afterAll(() => {
  const d = db();
  setDb(undefined);
  d.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a WAL handle */
  }
});

const base = { host: "127.0.0.1:3000", "content-type": "application/json" };
const post = (url: string, json: unknown) => new Request(`http://127.0.0.1:3000${url}`, { method: "POST", headers: base, body: JSON.stringify(json) });
const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) }) as never;

describe("montage API", () => {
  it("creates a montage project, takes several uploads and queues the job", async () => {
    const res = await createMontage(post("/api/montages", { count: 4, minSec: 12, maxSec: 8, title: "Trip" }), ctx());
    expect(res.status).toBe(201);
    const { project } = (await res.json()) as { project: Project };
    expect(project.kind).toBe("montage");
    expect(project.options).toEqual({ count: 4, minSec: 12, maxSec: 12 }); // max never below min

    // nothing uploaded yet
    expect((await buildMontage(post(`/api/montages/${project.id}`, {}), ctx({ id: project.id }))).status).toBe(400);

    const ids: string[] = [];
    for (const name of ["a.mp4", "b.mov"]) {
      const up = await startUpload(post("/api/uploads", { filename: name, size: 1000, projectId: project.id }), ctx());
      const j = (await up.json()) as { projectId: string; sourceId: string };
      expect(j.projectId).toBe(project.id);
      ids.push(j.sourceId);
    }
    // still uploading: refused
    expect((await buildMontage(post(`/api/montages/${project.id}`, {}), ctx({ id: project.id }))).status).toBe(409);
    run("update source_videos set status = 'ready' where project_id = ?", project.id);

    const built = await buildMontage(post(`/api/montages/${project.id}`, { count: 2 }), ctx({ id: project.id }));
    expect(built.status).toBe(200);
    const jobs = all<{ type: string; payload: string }>("select type, payload from jobs where project_id = ?", project.id);
    expect(jobs.map((j) => j.type)).toEqual(["montage"]);
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ project_id: project.id, count: 2, minSec: 12, maxSec: 12 });

    // the project page gets its videos; the montage list has it, the clip project list does not
    const detail = (await (await getProject(new Request("http://127.0.0.1:3000/"), ctx({ id: project.id }))).json()) as { inputs: SourceVideo[] };
    expect(detail.inputs.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(detail.inputs.every((s) => s.role === "input")).toBe(true);
    const listed = (await (await listMontages(new Request("http://127.0.0.1:3000/"), ctx())).json()) as { projects: Project[] };
    expect(listed.projects.map((p) => p.id)).toContain(project.id);
    expect(listProjects("clips").map((p) => p.id)).not.toContain(project.id);
  });

  it("shows the newest scene pool as the project's video", async () => {
    const { project } = (await (await createMontage(post("/api/montages", { count: 1, minSec: 5, maxSec: 9 }), ctx())).json()) as { project: Project };
    run("insert into source_videos (id, project_id, origin, status, role) values ('in1', ?, 'upload', 'ready', 'input')", project.id);
    run(
      "insert into source_videos (id, project_id, origin, status, role, scenes, created_at) values ('pool1', ?, 'upload', 'ready', 'pool', ?, '2030-01-01T00:00:00Z')",
      project.id,
      JSON.stringify([{ id: "s0_0", s: 0, e: 2, from: "in1", name: "a.mp4", score: 50 }]),
    );
    const detail = (await (await getProject(new Request("http://127.0.0.1:3000/"), ctx({ id: project.id }))).json()) as { source: SourceVideo; inputs: SourceVideo[] };
    expect(detail.source.id).toBe("pool1");
    expect(detail.source.scenes?.[0]?.name).toBe("a.mp4");
    expect(detail.inputs.map((s) => s.id)).toEqual(["in1"]);
  });

  it("refuses to make montages for an ordinary project", async () => {
    run("insert into projects (id, title) values ('plain', 'Plain')");
    expect((await buildMontage(post("/api/montages/plain", {}), ctx({ id: "plain" }))).status).toBe(400);
  });
});

// ── editor steps ──────────────────────────────────────────────────────────
const scenes: MontageScene[] = [
  { id: "s0_0", s: 0, e: 2.5, from: "a", name: "a.mp4", score: 60 },
  { id: "s1_0", s: 2.5, e: 5, from: "b", name: "b.mp4", score: 50 },
  { id: "s1_1", s: 5, e: 8, from: "b", name: "b.mp4", score: 40 },
];
const edit = (): EditState =>
  ({
    version: 1,
    video: [
      { id: "p1", srcStart: 2.5, srcEnd: 5 },
      { id: "p2", srcStart: 0, srcEnd: 2.5, volume: 0.6 },
    ],
    volume: 1,
  }) as unknown as EditState;

describe("montage editor steps", () => {
  it("adds a whole scene after the selected one or at the end", () => {
    const end = produce(edit(), addScene(scenes[2]!));
    expect(end.video.map((p) => [p.srcStart, p.srcEnd])).toEqual([[2.5, 5], [0, 2.5], [5, 8]]);
    const after = produce(edit(), addScene(scenes[2]!, "p1"));
    expect(after.video.map((p) => p.srcStart)).toEqual([2.5, 5, 0]);
    expect(new Set(after.video.map((p) => p.id)).size).toBe(3);
  });

  it("crops the middle of a scene of another shape", () => {
    const fit: MontageScene = { id: "v0", s: 8, e: 10, from: "c", name: "phone.mp4", score: 50, fit: true };
    const out = produce(edit(), addScene(fit));
    expect(out.video[2]!.frame).toEqual({ layout: "crop", cx: 0.5, cy: 0.5, zoom: 1 });
    expect(produce(edit(), addScene(scenes[0]!)).video[2]!.frame).toBeUndefined();
  });

  it("moves scenes and stops at the ends", () => {
    expect(produce(edit(), moveScene("p2", -1)).video.map((p) => p.id)).toEqual(["p2", "p1"]);
    expect(produce(edit(), moveScene("p1", -1)).video.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("mutes everything and unmutes to full volume", () => {
    const muted = produce(edit(), setMuted(true));
    expect(muted.volume).toBe(0);
    expect(muted.video.every((p) => p.volume === undefined)).toBe(true);
    expect(isMuted(muted)).toBe(true);
    const back = produce(muted, setMuted(false));
    expect(back.volume).toBe(1);
    expect(isMuted(back)).toBe(false);
    expect(isMuted({ volume: 0, video: [{ volume: 0.5 }] })).toBe(false);
  });

  it("finds the scene a piece comes from", () => {
    expect(sceneOfPiece(scenes, { srcStart: 2.5 })?.id).toBe("s1_0");
    expect(sceneOfPiece(scenes, { srcStart: 6.2 })?.id).toBe("s1_1");
    expect(sceneOfPiece(scenes, { srcStart: 9 })).toBeUndefined();
  });
});
