import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PLATFORM_LIMITS, captionLength, composeCaptionUntruncated } from "@klipz/publishers";
import { PROVIDERS } from "@klipz/shared";
import { setupTestEnv, cleanup, freshDb, seedClip, type Seed } from "./test-helpers";

const tmp = setupTestEnv("captions");

import { newId, run } from "../db";
import { HttpError } from "../http";
import { DEFAULT_MODEL, clampSuggestion, generateCaptions, type AnthropicLike } from "./captions";

afterAll(() => cleanup(tmp));

let seed: Seed;
beforeEach(() => {
  freshDb(tmp);
  seed = seedClip();
  const words = "Sleep deprivation destroys memory. Researchers found that sleep consolidates memory every night. Protect your sleep schedule, because memory depends on it.".split(" ");
  const ws = words.map((w, i) => ({ w, s: 10 + i * 0.3, e: 10.25 + i * 0.3 }));
  run("insert into transcripts (id, source_video_id, words) values (?, ?, ?)", newId(), seed.sourceId, JSON.stringify(ws));
});

const total = (provider: (typeof PROVIDERS)[number], s: { caption: string; hashtags: string[] }) =>
  captionLength(provider, composeCaptionUntruncated(provider, { caption: s.caption, hashtags: s.hashtags, options: {} }));

describe("offline generator", () => {
  it("is used when no API key is set and says so; every platform stays within its limit", async () => {
    const r = await generateCaptions({ clipId: seed.clipId, providers: [...PROVIDERS] }, { env: {} });
    expect(r.generator).toBe("heuristic");
    expect(Object.keys(r.captions).sort()).toEqual([...PROVIDERS].sort());
    for (const p of PROVIDERS) {
      const c = r.captions[p]!;
      expect(c.caption.length).toBeGreaterThan(0);
      expect(total(p, c)).toBeLessThanOrEqual(PLATFORM_LIMITS[p].captionMax);
      expect(c.hashtags.every((t) => /^#[\p{L}\p{N}_]+$/u.test(t))).toBe(true);
    }
    expect(r.captions.youtube!.title!.length).toBeLessThanOrEqual(100);
    expect(r.captions.youtube!.title).toBe("Why sleep matters");
    expect(r.captions.tiktok!.caption.startsWith("Why sleep matters")).toBe(true); // hook first
    expect(r.captions.tiktok!.hashtags.length).toBeGreaterThanOrEqual(3);
    expect(r.captions.tiktok!.hashtags.length).toBeLessThanOrEqual(6);
    expect(r.captions.linkedin!.caption).toMatch(/take/i);
    // keywords come from the transcript
    expect(r.captions.instagram!.hashtags.map((t) => t.toLowerCase())).toEqual(expect.arrayContaining(["#sleep", "#memory"]));
  });

  it("keeps X within 280 weighted characters including hashtags, even for huge hooks", async () => {
    run("update clips set hook = ? where id = ?", "very long hook ".repeat(60), seed.clipId);
    const r = await generateCaptions({ clipId: seed.clipId, providers: ["x"] }, { env: {} });
    expect(total("x", r.captions.x!)).toBeLessThanOrEqual(280);
    expect(r.captions.x!.hashtags.length).toBeLessThanOrEqual(3);
  });

  it("404s for an unknown clip", async () => {
    await expect(generateCaptions({ clipId: "nope", providers: ["x"] }, { env: {} })).rejects.toBeInstanceOf(HttpError);
  });
});

describe("Claude generator (fake client)", () => {
  const client = (input: unknown): AnthropicLike & { create: ReturnType<typeof vi.fn> } => {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: "hm" }, { type: "tool_use", name: "submit_captions", input }] }));
    return { messages: { create }, create };
  };

  it("uses structured output, the configured model, and clamps oversize output", async () => {
    const c = client({
      x: { caption: "word ".repeat(200), hashtags: ["#One", "two words", "#three", "#four", "#five", "#One"] },
      youtube: { caption: "desc", hashtags: ["a"], title: "T".repeat(300) },
    });
    const r = await generateCaptions({ clipId: seed.clipId, providers: ["x", "youtube"], tone: "casual" }, { client: c, env: { ANTHROPIC_MODEL: "my-model" } });
    expect(r.generator).toBe("claude");
    expect(r.model).toBe("my-model");
    const params = c.create.mock.calls[0]![0] as { model: string; tool_choice: { name: string }; messages: { content: string }[]; tools: { input_schema: { required: string[] } }[] };
    expect(params.model).toBe("my-model");
    expect(params.tool_choice).toEqual({ type: "tool", name: "submit_captions" });
    expect(params.tools[0]!.input_schema.required).toEqual(["x", "youtube"]);
    expect(params.messages[0]!.content).toContain("Tone: casual");
    expect(params.messages[0]!.content).toContain("Sleep deprivation");
    expect(total("x", r.captions.x!)).toBeLessThanOrEqual(280);
    expect(r.captions.x!.hashtags).toEqual(["#One", "#twowords", "#three"]); // deduped, normalised, capped
    expect(r.captions.youtube!.title!.length + " #Shorts".length).toBeLessThanOrEqual(100);
  });

  it("defaults the model name", async () => {
    const c = client({ x: { caption: "hi", hashtags: [] } });
    const r = await generateCaptions({ clipId: seed.clipId, providers: ["x"] }, { client: c, env: {} });
    expect(r.model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("claude-opus-5-5");
  });

  it("falls back per platform when the model omitted one or returned junk", async () => {
    const r = await generateCaptions({ clipId: seed.clipId, providers: ["x", "tiktok"] }, { client: client({ x: { caption: "ok", hashtags: [] }, tiktok: { nope: 1 } }), env: {} });
    expect(r.generator).toBe("claude");
    expect(r.captions.x!.caption).toBe("ok");
    expect(r.captions.tiktok!.caption).toContain("Why sleep matters");
    expect(r.note).toMatch(/tiktok/);
  });

  it("falls back to the offline generator on any client error or missing structured output", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boom: AnthropicLike = { messages: { create: async () => { throw new Error("401 invalid x-api-key"); } } };
    const r1 = await generateCaptions({ clipId: seed.clipId, providers: ["x"] }, { client: boom, env: {} });
    expect(r1.generator).toBe("heuristic");
    expect(r1.note).toMatch(/offline generator/);
    const empty: AnthropicLike = { messages: { create: async () => ({ content: [{ type: "text", text: "sorry" }] }) } };
    expect((await generateCaptions({ clipId: seed.clipId, providers: ["x"] }, { client: empty, env: {} })).generator).toBe("heuristic");
    warn.mockRestore();
  });
});

describe("clampSuggestion", () => {
  it("never exceeds any platform limit", () => {
    for (const p of PROVIDERS) {
      const out = clampSuggestion(p, { caption: "é ".repeat(6000), hashtags: Array.from({ length: 80 }, (_, i) => `tag${i}`), title: "x".repeat(500) });
      expect(total(p, out)).toBeLessThanOrEqual(PLATFORM_LIMITS[p].captionMax);
      if (out.title) expect(out.title.length).toBeLessThanOrEqual(PLATFORM_LIMITS[p].titleMax ?? 100);
    }
  });
  it("drops titles on platforms without one", () => {
    expect(clampSuggestion("tiktok", { caption: "a", hashtags: [], title: "t" }).title).toBeUndefined();
  });
});
