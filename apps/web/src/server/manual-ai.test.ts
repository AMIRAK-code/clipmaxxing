import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Project } from "@klipz/shared";
import { afterAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-manual-"));
process.env.KLIPZ_DATA_DIR = tmp;

import { GET as getProject, PATCH as patchProject } from "@/app/api/projects/[id]/route";
import { GET as listFiles, POST as manualAction } from "@/app/api/projects/[id]/manual/route";
import { POST as manualClips } from "@/app/api/projects/[id]/manual/clips/route";
import { all, db, run, setDb } from "./db";
import { storagePath } from "./paths";

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

const headers = { host: "127.0.0.1:3000", "content-type": "application/json" };
const req = (method: string, json?: unknown) =>
  new Request("http://127.0.0.1:3000/x", { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

function seed(id: string, kind = "clips", videos: Array<[string, string, number]> = [[`${id}-v1`, "talk.mp4", 300]]) {
  run("insert into projects (id, title, kind) values (?, ?, ?)", id, "P", kind);
  videos.forEach(([sid, name, dur], i) =>
    run(
      "insert into source_videos (id, project_id, origin, filename, duration_sec, status, created_at) values (?, ?, 'upload', ?, ?, 'ready', ?)",
      sid,
      id,
      name,
      dur,
      `2026-01-01T00:00:0${i}Z`,
    ),
  );
}

describe("Manual AI Mode API", () => {
  it("records the engine choice", async () => {
    seed("p0");
    const res = await patchProject(req("PATCH", { engine: "builtin" }), ctx("p0"));
    expect(((await res.json()) as { project: Project }).project.options).toEqual({ engine: "builtin" });
    expect((await patchProject(req("PATCH", {}), ctx("p0"))).status).toBe(400);
  });

  it("switches to manual mode and queues the export, then lists the files in order", async () => {
    seed("p1");
    const res = await manualAction(req("POST", { action: "export" }), ctx("p1"));
    expect(res.status).toBe(200);
    const jobs = all<{ type: string; payload: string }>("select type, payload from jobs where project_id = 'p1'");
    expect(jobs.map((j) => j.type)).toEqual(["manual_export"]);
    const proj = (await (await getProject(req("GET"), ctx("p1"))).json()) as { project: Project };
    expect(proj.project.options?.engine).toBe("manual");

    // nothing made yet
    expect(((await (await listFiles(req("GET"), ctx("p1"))).json()) as { files: unknown[] }).files).toEqual([]);
    expect((await manualAction(req("POST", { action: "open" }), ctx("p1"))).status).toBeGreaterThanOrEqual(400);
    // what the worker writes
    for (const name of ["gemini_prompt.txt", "video_light.mp4", "video_transcript.txt", "video_light.part.mp4"]) {
      const p = storagePath(`projects/p1/manual/${name}`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "x");
    }
    const files = ((await (await listFiles(req("GET"), ctx("p1"))).json()) as { files: Array<{ name: string; key: string }> }).files;
    expect(files.map((f) => f.name)).toEqual(["video_transcript.txt", "video_light.mp4", "gemini_prompt.txt"]);
    expect(files[0]!.key).toBe("projects/p1/manual/video_transcript.txt");
  });

  it("turns pasted JSON into a manual_clips job with the project's video ids", async () => {
    seed("p2", "montage", [["a1", "first.mp4", 100], ["a2", "second.mp4", 50]]);
    const answer = `Sure! Here are the clips:
\`\`\`json
{"clips": [{"title": "Best", "text_on_screen": "Watch this", "segments": [{"video": 2, "start": "0:05", "end": 9}, {"video": 1, "start": 20, "end": 120}]}]}
\`\`\``;
    const res = await manualClips(req("POST", { json: answer }), ctx("p2"));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { clips: number; warnings: string[] };
    expect(out.clips).toBe(1);
    expect(out.warnings.join(" ")).toMatch(/shortened/);
    const job = all<{ type: string; payload: string }>("select type, payload from jobs where project_id = 'p2'")[0]!;
    expect(job.type).toBe("manual_clips");
    expect(JSON.parse(job.payload)).toEqual({
      project_id: "p2",
      clips: [{ title: "Best", hook: "Watch this", segments: [{ source: "a2", start: 5, end: 9 }, { source: "a1", start: 20, end: 100 }] }],
    });
  });

  it("explains JSON it cannot use", async () => {
    seed("p3");
    const res = await manualClips(req("POST", { json: "this is not json" }), ctx("p3"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/No JSON found/);
  });
});
