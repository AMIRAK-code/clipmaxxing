import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeEngine, aiSettingsView, resolveAi, saveAiSettings } from "./ai-settings";

describe("ai settings", () => {
  let dir: string;
  const key = randomBytes(32).toString("base64");
  const o = () => ({ dir, key });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-ai-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("defaults to the Smart Edit engine with smart edit on", () => {
    const v = aiSettingsView({}, o());
    expect(v).toMatchObject({ provider: "auto", smartEdit: true, active: "smart", envLocked: [] });
    expect(v.anthropic.keySet).toBe(false);
  });

  it("seals keys, never exposes them, and keeps a key when the patch omits it", () => {
    saveAiSettings({ provider: "auto", anthropic: { apiKey: "sk-ant-secret", model: "claude-x" } }, o());
    const raw = fs.readFileSync(path.join(dir, "ai-settings.json"), "utf8");
    expect(raw).not.toContain("sk-ant-secret");
    const v = aiSettingsView({}, o());
    expect(JSON.stringify(v)).not.toContain("sk-ant-secret");
    expect(v).toMatchObject({ active: "anthropic", anthropic: { keySet: true, keyFromEnv: false, model: "claude-x" } });
    saveAiSettings({ anthropic: { model: "claude-y" } }, o());
    expect(resolveAi({}, o())).toMatchObject({ anthropicKey: "sk-ant-secret", anthropicModel: "claude-y" });
    saveAiSettings({ anthropic: { apiKey: null } }, o());
    expect(aiSettingsView({}, o()).active).toBe("smart");
  });

  it("picks the engine like the worker does", () => {
    saveAiSettings({ openai: { baseUrl: "http://127.0.0.1:1234/v1/", model: "local" }, ollama: { model: "llama3" } }, o());
    expect(resolveAi({}, o()).openaiBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(activeEngine(resolveAi({}, o()))).toBe("openai"); // local server: no key needed
    saveAiSettings({ provider: "ollama" }, o());
    expect(activeEngine(resolveAi({}, o()))).toBe("ollama");
    saveAiSettings({ provider: "none", smartEdit: false }, o());
    expect(aiSettingsView({}, o())).toMatchObject({ active: "smart", smartEdit: false });
  });

  it("lets environment variables win and reports them as locked", () => {
    saveAiSettings({ provider: "none", anthropic: { apiKey: "file-key" } }, o());
    const v = aiSettingsView({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "env-key", KLIPZ_SMART_EDIT: "0" }, o());
    expect(v).toMatchObject({ provider: "anthropic", active: "anthropic", smartEdit: false, anthropic: { keyFromEnv: true } });
    expect(v.envLocked).toEqual(["LLM_PROVIDER", "KLIPZ_SMART_EDIT", "ANTHROPIC_API_KEY"]);
  });

  it("ignores a key it cannot decrypt", () => {
    saveAiSettings({ anthropic: { apiKey: "k" } }, o());
    expect(resolveAi({}, { dir, key: randomBytes(32).toString("base64") }).anthropicKey).toBe("");
  });
});
