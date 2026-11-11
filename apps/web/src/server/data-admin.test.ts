import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addAccount, cleanup, freshDb, seedClip, setupTestEnv } from "./social/test-helpers";

const tmp = setupTestEnv("admin");

import { all, get, newId, run } from "./db";
import { deleteAllData, disconnectAllAccounts, dirSize, keysPresent, llmScorerLabel, systemStatus } from "./data-admin";
import { MAX_LOG_BYTES, logError, logFile, readLogTail } from "./log";
import { deleteFinishedJob, enqueueJob } from "./jobs";
import { storageDir } from "./paths";

beforeAll(() => freshDb(tmp));
afterAll(() => cleanup(tmp));

describe("deleteAllData", () => {
  it("disconnects accounts, wipes rows and storage, keeps the app runnable", () => {
    const seed = seedClip();
    addAccount("youtube");
    addAccount("x");
    run("insert into posts (id, batch_id, clip_id, render_id, provider, caption, status) values (?, ?, ?, ?, 'x', 'c', 'published')", newId(), newId(), seed.clipId, seed.renderId);
    enqueueJob("cleanup", {});
    run("insert into settings (key, value) values ('worker_heartbeat', ?), ('foo', 'bar')", new Date().toISOString());
    fs.writeFileSync(path.join(storageDir(), "stray.bin"), "x");
    // the local secret key must survive
    fs.writeFileSync(path.join(tmp, "secret.key"), "keep-me");

    const r = deleteAllData();
    expect(r.accountsDisconnected).toBe(2);
    for (const t of ["projects", "clips", "renders", "posts", "social_accounts", "jobs", "source_videos"]) {
      expect(get<{ n: number }>(`select count(*) as n from ${t}`)?.n, t).toBe(0);
    }
    expect(all("select key from settings")).toEqual([{ key: "worker_heartbeat" }]);
    expect(fs.readdirSync(storageDir())).toEqual([]);
    expect(fs.readFileSync(path.join(tmp, "secret.key"), "utf8")).toBe("keep-me");
    // still usable afterwards
    run("insert into projects (id, title) values (?, 'again')", newId());
    expect(get<{ n: number }>("select count(*) as n from projects")?.n).toBe(1);
    // and foreign keys are enforced again
    expect(() => run("insert into clips (id, project_id, source_video_id, start_sec, end_sec) values (?, 'nope', 'nope', 0, 1)", newId())).toThrow();
  });
});

describe("disconnectAllAccounts", () => {
  it("removes accounts but keeps post history unlinked", () => {
    const seed = seedClip();
    const acc = addAccount("linkedin");
    const postId = newId();
    run("insert into posts (id, batch_id, clip_id, render_id, social_account_id, provider, caption, status) values (?, ?, ?, ?, ?, 'linkedin', 'c', 'published')", postId, newId(), seed.clipId, seed.renderId, acc.id);
    expect(disconnectAllAccounts()).toBeGreaterThanOrEqual(1);
    expect(get<{ social_account_id: string | null }>("select social_account_id from posts where id = ?", postId)?.social_account_id).toBeNull();
  });
});

describe("dead-letter delete", () => {
  it("deletes finished jobs only", () => {
    const j = enqueueJob("cleanup", {}, { dedupeKey: "dlq-test" });
    expect(deleteFinishedJob(j.id)).toBe(false); // queued
    run("update jobs set status = 'dead' where id = ?", j.id);
    expect(deleteFinishedJob(j.id)).toBe(true);
    expect(get("select 1 from jobs where id = ?", j.id)).toBeUndefined();
  });
});

describe("error log", () => {
  it("appends and rotates at the size limit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-log-"));
    logError("api GET /x", new Error("boom"), { dir, now: new Date("2026-01-01T00:00:00Z") });
    expect(readLogTail(1000, dir)[0]).toMatch(/^2026-01-01T00:00:00.000Z \[api GET \/x\] Error: boom/);
    for (let i = 0; i < 5; i++) logError("t", "x".repeat(40), { dir, maxBytes: 100 });
    expect(fs.existsSync(`${logFile(dir)}.1`)).toBe(true);
    expect(fs.statSync(logFile(dir)).size).toBeLessThan(400);
    expect(MAX_LOG_BYTES).toBe(5 * 1024 * 1024);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it("never throws", () => {
    expect(() => logError("t", { circular: 1 }, { dir: "Z:\\definitely\\not\\here\\\0" })).not.toThrow();
  });
});

describe("status helpers", () => {
  it("dirSize sums files recursively", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-ds-"));
    fs.mkdirSync(path.join(d, "a"));
    fs.writeFileSync(path.join(d, "a", "f"), "12345");
    fs.writeFileSync(path.join(d, "g"), "123");
    expect(dirSize(d)).toEqual({ bytes: 8, files: 2 });
    fs.rmSync(d, { recursive: true, force: true });
  });
  it("keysPresent reports presence from env and files, never values", () => {
    const f = path.join(tmp, "x.env");
    fs.writeFileSync(f, "# c\nELEVENLABS_API_KEY=abc\nANTHROPIC_API_KEY=\nexport OLLAMA_MODEL='llama'\n");
    const k = keysPresent(["ELEVENLABS_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "AGGREGATOR_API_KEY"], { AGGREGATOR_API_KEY: "s" }, [f]);
    expect(k).toEqual({ ELEVENLABS_API_KEY: true, ANTHROPIC_API_KEY: false, OLLAMA_MODEL: true, AGGREGATOR_API_KEY: true });
  });
  it("scorer label follows the worker's rules", () => {
    expect(llmScorerLabel({ ANTHROPIC_API_KEY: true }, {})).toBe("Claude (Anthropic API)");
    expect(llmScorerLabel({}, {})).toMatch(/^Heuristic/);
    expect(llmScorerLabel({ ANTHROPIC_API_KEY: true }, { LLM_PROVIDER: "none" })).toMatch(/^Heuristic/);
    expect(llmScorerLabel({ OLLAMA_MODEL: true }, {})).toBe("Ollama (local)");
  });
  it("systemStatus reports an offline worker when the health call fails", async () => {
    run("delete from settings where key = 'worker_heartbeat'");
    const s = await systemStatus((async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(s.worker.online).toBe(false);
    expect(s.dataDir).toBe(tmp);
    expect(s.node).toMatch(/^v\d+/);
  });
  it("systemStatus reads handlers from the health endpoint", async () => {
    const s = await systemStatus((async () =>
      new Response(JSON.stringify({ ok: true, handlers: ["render", "cleanup"], current_job: null }), { status: 200 })) as unknown as typeof fetch);
    expect(s.worker.online).toBe(true);
    expect(s.worker.handlers).toEqual(["render", "cleanup"]);
  });
});
