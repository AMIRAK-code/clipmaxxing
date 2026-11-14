import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-web-02-"));
process.env.KLIPZ_DATA_DIR = tmp;

import { cleanFrame, effectiveCropTrack, layoutAt, manualCropTrack, MAX_FRAME_ZOOM, type EditState } from "@klipz/shared";
import { produce } from "immer";
import * as ops from "@/lib/editor/ops";
import { BREAKDOWN_KEYS, breakdownValue, scorerLabel } from "@/lib/clip-ui";
import { activeEngine, aiSettingsView, chatEngine, resolveAi, saveAiSettings, suggestGeminiModel } from "./ai-settings";
import { all, get, newId, openDb, run, setDb } from "./db";
import { setSourceFraming } from "./framing";
import { createRender } from "./renders";
import { openAiCompatClient } from "./social/captions";

const MIGRATIONS = path.resolve(__dirname, "../../../../db/migrations");
const opened: { close(): void }[] = [];

function fresh(): { projectId: string; sourceId: string; clips: string[] } {
  const d = openDb(path.join(tmp, `t-${newId()}.db`), MIGRATIONS);
  opened.push(d);
  setDb(d);
  const projectId = newId();
  const sourceId = newId();
  run("insert into projects (id, title) values (?, 'P')", projectId);
  run("insert into source_videos (id, project_id, origin, status, duration_sec) values (?, ?, 'upload', 'ready', 100)", sourceId, projectId);
  const track = JSON.stringify({ version: 1, srcW: 1920, srcH: 1080, segments: [] });
  const clips = [newId(), newId(), newId()];
  // two framed clips (one discarded) and one that was never framed
  run("insert into clips (id, project_id, source_video_id, start_sec, end_sec, crop_track) values (?, ?, ?, 0, 20, ?)", clips[0]!, projectId, sourceId, track);
  run("insert into clips (id, project_id, source_video_id, start_sec, end_sec, crop_track, status) values (?, ?, ?, 30, 50, ?, 'discarded')", clips[1]!, projectId, sourceId, track);
  run("insert into clips (id, project_id, source_video_id, start_sec, end_sec) values (?, ?, ?, 60, 80)", clips[2]!, projectId, sourceId);
  return { projectId, sourceId, clips };
}

afterAll(() => {
  setDb(undefined);
  for (const d of opened) d.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a WAL handle */
  }
});

describe("source framing", () => {
  it("defaults to speaker and re-frames only clips that were framed", () => {
    const { sourceId, clips } = fresh();
    expect(get<{ framing: string }>("select framing from source_videos where id = ?", sourceId)!.framing).toBe("speaker");
    const r = setSourceFraming(sourceId, "center");
    expect(r.source.framing).toBe("center");
    expect(r.reframed).toBe(1); // the live framed clip; not the discarded one, not the unframed one
    expect(all<{ crop_track: string | null }>("select crop_track from clips where source_video_id = ?", sourceId).every((c) => c.crop_track === null)).toBe(true);
    const jobs = all<{ type: string; payload: string }>("select type, payload from jobs");
    expect(jobs.map((j) => j.type)).toEqual(["reframe"]);
    expect(JSON.parse(jobs[0]!.payload)).toEqual({ clip_id: clips[0], force: true });
  });

  it("does nothing when the framing is unchanged and rejects unknown sources", () => {
    const { sourceId } = fresh();
    expect(setSourceFraming(sourceId, "speaker").reframed).toBe(0);
    expect(get<{ n: number }>("select count(*) n from jobs")!.n).toBe(0);
    expect(() => setSourceFraming(newId(), "fit")).toThrow(/not found/i);
  });
});

describe("render engine choice", () => {
  it("stores engine only when Studio is asked for, and keeps Studio and fast renders apart", () => {
    const { clips } = fresh();
    const fast = createRender(clips[0]!, {});
    expect((fast.render as unknown as { options: unknown }).options).toEqual({ denoise: false });
    expect(createRender(clips[0]!, { engine: "auto" }).reused).toBe(true);
    const studio = createRender(clips[0]!, { engine: "studio" });
    expect(studio.reused).toBe(false);
    expect((studio.render as unknown as { options: unknown }).options).toEqual({ denoise: false, engine: "studio" });
    expect(createRender(clips[0]!, { engine: "studio" }).reused).toBe(true);
  });
});

describe("manual framing", () => {
  it("cleans values coming from the editor", () => {
    expect(cleanFrame({ layout: "crop", cx: -1, cy: 2, zoom: 99 })).toEqual({ layout: "crop", cx: 0, cy: 1, zoom: MAX_FRAME_ZOOM });
    expect(cleanFrame({ layout: "nope" as never, cx: Number.NaN, cy: 0.3, zoom: 0 })).toEqual({ layout: "crop", cx: 0.5, cy: 0.3, zoom: 1 });
  });

  it("crops a window of 1/zoom the size around the chosen point, kept inside the picture", () => {
    const wide = layoutAt(manualCropTrack({ layout: "crop", cx: 0.5, cy: 0.5, zoom: 1 }, 1920, 1080), 12, 1080, 1920, 1920, 1080);
    expect(wide.panes[0]!.src).toEqual({ x: (1920 - 607.5) / 2, y: 0, w: 607.5, h: 1080 });
    const close = layoutAt(manualCropTrack({ layout: "crop", cx: 0.25, cy: 0.5, zoom: 2 }, 1920, 1080), 999, 1080, 1920, 1920, 1080);
    expect(close.panes[0]!.src).toEqual({ x: 480 - 151.875, y: 270, w: 303.75, h: 540 });
    const edge = layoutAt(manualCropTrack({ layout: "crop", cx: 1, cy: 0, zoom: 2 }, 1920, 1080), 0, 1080, 1920, 1920, 1080);
    expect(edge.panes[0]!.src.x + edge.panes[0]!.src.w).toBeCloseTo(1920);
    expect(edge.panes[0]!.src.y).toBe(0);
    expect(layoutAt(manualCropTrack({ layout: "letterbox", cx: 0.5, cy: 0.5, zoom: 3 }, 1920, 1080), 0, 1080, 1920, 1920, 1080)).toMatchObject({ layout: "letterbox", blurredBackground: true });
  });

  it("replaces the automatic track only when the edit has a frame", () => {
    const auto = { version: 1 as const, srcW: 1920, srcH: 1080, segments: [] };
    expect(effectiveCropTrack({}, auto, 1920, 1080)).toBe(auto);
    expect(effectiveCropTrack({ frame: null }, auto, 1920, 1080)).toBe(auto);
    expect(effectiveCropTrack({ frame: { layout: "crop", cx: 0.2, cy: 0.5, zoom: 1.5 } }, auto, 1920, 1080)!.segments[0]).toMatchObject({ layout: "crop", zoom: 1.5, keys: [{ t: 0, cx: 0.2, cy: 0.5 }] });
  });

  it("editor ops set, adjust and clear the frame", () => {
    const base = { version: 1, video: [] } as unknown as EditState;
    const manual = produce(base, ops.patchFrame({ zoom: 2 }));
    expect(manual.frame).toEqual({ layout: "crop", cx: 0.5, cy: 0.5, zoom: 2 });
    const moved = produce(manual, ops.patchFrame({ cx: 0.8, zoom: 9 }));
    expect(moved.frame).toEqual({ layout: "crop", cx: 0.8, cy: 0.5, zoom: MAX_FRAME_ZOOM });
    expect("frame" in produce(moved, ops.setFrame(null))).toBe(false);
  });
});

describe("AI providers: Gemini and custom", () => {
  let dir: string;
  const key = randomBytes(32).toString("base64");
  const o = () => ({ dir, key });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmp, "ai-"));
  });

  it("Gemini needs a key and a model; the model id loses its models/ prefix", () => {
    saveAiSettings({ gemini: { apiKey: "g-secret" } }, o());
    expect(aiSettingsView({}, o())).toMatchObject({ active: "smart", gemini: { keySet: true, model: "" } });
    saveAiSettings({ gemini: { model: "models/gemini-9-flash" } }, o());
    const v = aiSettingsView({}, o());
    expect(v).toMatchObject({ active: "gemini", gemini: { keySet: true, keyFromEnv: false, model: "gemini-9-flash" } });
    expect(JSON.stringify(v)).not.toContain("g-secret");
    expect(fs.readFileSync(path.join(dir, "ai-settings.json"), "utf8")).not.toContain("g-secret");
    expect(chatEngine({}, o())).toEqual({ kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: "g-secret", model: "gemini-9-flash" });
  });

  it("custom API needs a base URL and a model, key optional; order is Claude, Gemini, OpenAI, custom, Ollama", () => {
    saveAiSettings({ custom: { baseUrl: "https://openrouter.ai/api/v1/", model: "meta/llama" }, ollama: { model: "local" } }, o());
    expect(activeEngine(resolveAi({}, o()))).toBe("custom");
    expect(chatEngine({}, o())).toEqual({ kind: "custom", baseUrl: "https://openrouter.ai/api/v1", apiKey: "", model: "meta/llama" });
    saveAiSettings({ provider: "ollama" }, o());
    expect(chatEngine({}, o())).toMatchObject({ kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "local" });
    saveAiSettings({ provider: "none" }, o());
    expect(chatEngine({}, o())).toBeNull();
    expect(aiSettingsView({ CUSTOM_AI_MODEL: "env-model", LLM_PROVIDER: "custom" }, o())).toMatchObject({ active: "custom", custom: { model: "env-model" }, envLocked: ["LLM_PROVIDER", "CUSTOM_AI_MODEL"] });
  });

  it("suggests the newest general Flash model", () => {
    expect(suggestGeminiModel(["gemini-2.5-pro", "gemini-3.6-flash", "gemini-3.6-flash-lite", "gemini-3.7-flash-preview", "gemini-embedding-001", "gemini-3.6-flash-image"])).toBe("gemini-3.6-flash");
    expect(suggestGeminiModel(["other-model"])).toBe("other-model");
    expect(suggestGeminiModel([])).toBeUndefined();
  });

  it("captions client speaks the OpenAI chat API and returns the reply as the tool call", async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const replies = [
      new Response("no json mode", { status: 400 }),
      new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"tiktok":{"caption":"Hi","hashtags":["a"]}}\n```' } }] }), { status: 200 }),
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return replies.shift()!;
    }) as unknown as typeof fetch;
    const client = openAiCompatClient({ kind: "gemini", baseUrl: "https://x/v1", apiKey: "k", model: "m" }, fakeFetch);
    const res = await client.messages.create({
      model: "ignored",
      tools: [{ name: "submit_captions", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "write" }],
    });
    expect(res.content).toEqual([{ type: "tool_use", name: "submit_captions", input: { tiktok: { caption: "Hi", hashtags: ["a"] } } }]);
    expect(calls.map((c) => c.url)).toEqual(["https://x/v1/chat/completions", "https://x/v1/chat/completions"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
    expect(calls[0]!.body).toMatchObject({ model: "m", response_format: { type: "json_object" } });
    expect("response_format" in calls[1]!.body).toBe(false); // retried without JSON mode after the 400
    const failing = openAiCompatClient({ kind: "custom", baseUrl: "https://x/v1", apiKey: "", model: "m" }, (async () => new Response("", { status: 500 })) as unknown as typeof fetch);
    await expect(failing.messages.create({ tools: [{ name: "t", input_schema: {} }], messages: [{ content: "x" }] })).rejects.toThrow(/500/);
  });
});

describe("score display", () => {
  it("labels every scorer and shows hype (energy on older clips)", () => {
    for (const [scorer, label] of [["gemini", "Gemini"], ["openai", "OpenAI"], ["custom", "Custom AI"], ["ollama", "Ollama"], ["anthropic", "Claude"], ["heuristic", "Heuristic"]] as const) {
      expect(scorerLabel({ scorer } as never)).toBe(label);
    }
    expect(BREAKDOWN_KEYS).toContain("hype");
    expect(breakdownValue({ hype: 71, energy: 20 } as never, "hype")).toBe(71);
    expect(breakdownValue({ energy: 20 } as never, "hype")).toBe(20);
    expect(breakdownValue({ hook: 55 } as never, "hook")).toBe(55);
  });
});
