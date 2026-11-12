import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteAppKeys, effectiveEnv, keySource, saveAppKeys, storedKeyEnv } from "./app-keys";

describe("app keys store", () => {
  let dir: string;
  const key = randomBytes(32).toString("base64");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-keys-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trips keys and never stores the secret in plaintext", () => {
    saveAppKeys("x", " cid ", " super-secret ", { dir, key });
    saveAppKeys("instagram", "meta-id", "meta-secret", { dir, key });
    const raw = fs.readFileSync(path.join(dir, "platform-keys.json"), "utf8");
    expect(raw).not.toContain("super-secret");
    expect(raw).not.toContain("meta-secret");
    expect(storedKeyEnv({ dir, key })).toEqual({ X_CLIENT_ID: "cid", X_CLIENT_SECRET: "super-secret", META_APP_ID: "meta-id", META_APP_SECRET: "meta-secret" });
  });

  it("lets real env win and fills only what is missing", () => {
    saveAppKeys("x", "stored-id", "stored-secret", { dir, key });
    saveAppKeys("tiktok", "tt-id", "tt-secret", { dir, key });
    const env = effectiveEnv({ X_CLIENT_ID: "env-id", X_CLIENT_SECRET: "env-secret" }, { dir, key });
    expect(env.X_CLIENT_ID).toBe("env-id");
    expect(env.TIKTOK_CLIENT_ID).toBe("tt-id");
    expect(keySource("x", { X_CLIENT_ID: "a", X_CLIENT_SECRET: "b" }, { dir })).toBe("env");
    expect(keySource("tiktok", {}, { dir })).toBe("app");
    expect(keySource("facebook", {}, { dir })).toBeNull();
  });

  it("deletes keys and skips entries it cannot decrypt", () => {
    saveAppKeys("x", "id", "secret", { dir, key });
    expect(storedKeyEnv({ dir, key: randomBytes(32).toString("base64") })).toEqual({});
    expect(deleteAppKeys("x", { dir })).toBe(true);
    expect(deleteAppKeys("x", { dir })).toBe(false);
    expect(storedKeyEnv({ dir, key })).toEqual({});
  });
});
