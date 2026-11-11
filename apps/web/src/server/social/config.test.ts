import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { setupTestEnv, cleanup, freshDb, addAccount } from "./test-helpers";

const tmp = setupTestEnv("config");

import { encryptionKey, providerConfig, providerStatus, readOrCreateSecretFile, redirectUriFor, sandboxMode, stateSecret } from "./config";
import { loadTokens, saveTokens, seal, unseal } from "./vault";
import { get } from "../db";

afterAll(() => cleanup(tmp));

describe("secret files", () => {
  it("creates a 32-byte base64 key on first use and reuses it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-keys-"));
    const a = readOrCreateSecretFile("secret.key", dir);
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(fs.existsSync(path.join(dir, "secret.key"))).toBe(true);
    expect(readOrCreateSecretFile("secret.key", dir)).toBe(a);
    expect(readOrCreateSecretFile("state.key", dir)).not.toBe(a);
    if (process.platform !== "win32") expect(fs.statSync(path.join(dir, "secret.key")).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("env overrides win; without env the key is generated under the data dir", () => {
    expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: "abc" })).toBe("abc");
    expect(stateSecret({ OAUTH_STATE_SECRET: "xyz" })).toBe("xyz");
    const k = encryptionKey({});
    expect(Buffer.from(k, "base64")).toHaveLength(32);
    expect(fs.existsSync(path.join(tmp, "secret.key"))).toBe(true);
    expect(stateSecret({})).toBeTruthy();
    expect(fs.existsSync(path.join(tmp, "state.key"))).toBe(true);
  });
});

describe("vault", () => {
  it("round-trips tokens and stores only ciphertext", () => {
    expect(unseal(seal("hello"))).toBe("hello");
    expect(seal("hello")).not.toContain("hello");
    freshDb(tmp);
    const acc = addAccount("x", "x1", { accessToken: "PLAINACCESS", refreshToken: "PLAINREFRESH", expiresAt: "2030-01-01T00:00:00.000Z" });
    const raw = get<{ access_token_enc: string; refresh_token_enc: string }>("select access_token_enc, refresh_token_enc from social_accounts where id = ?", acc.id)!;
    expect(raw.access_token_enc).not.toContain("PLAINACCESS");
    expect(raw.refresh_token_enc).not.toContain("PLAINREFRESH");
    expect(loadTokens(acc.id)).toMatchObject({ accessToken: "PLAINACCESS", refreshToken: "PLAINREFRESH", expiresAt: "2030-01-01T00:00:00.000Z" });
    saveTokens(acc.id, { accessToken: "NEW", scopes: [] });
    // a rotated set without a refresh token keeps the stored one
    expect(loadTokens(acc.id)).toMatchObject({ accessToken: "NEW", refreshToken: "PLAINREFRESH" });
    expect(JSON.stringify(acc)).not.toMatch(/PLAIN|_enc/);
  });
});

describe("provider config", () => {
  it("maps env to config with redirect URI and extras", () => {
    const env = { META_APP_ID: "id", META_APP_SECRET: "sec", META_GRAPH_VERSION: "v99.0", APP_URL: "https://t.example/", LINKEDIN_CLIENT_ID: "l", LINKEDIN_CLIENT_SECRET: "s", LINKEDIN_VERSION: "202601" };
    expect(providerConfig("instagram", env)).toEqual({ clientId: "id", clientSecret: "sec", redirectUri: "https://t.example/api/oauth/instagram/callback", extra: { graphVersion: "v99.0" } });
    expect(providerConfig("linkedin", env)?.extra).toEqual({ linkedinVersion: "202601" });
    expect(providerConfig("youtube", env)).toBeUndefined();
    expect(redirectUriFor("x", {})).toBe("http://localhost:3000/api/oauth/x/callback");
  });

  it("providerStatus reports configured / missing / viaAggregator without leaking values", () => {
    const s = providerStatus({ YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", X_CLIENT_ID: "only-id", AGGREGATOR_KIND: "upload-post", AGGREGATOR_API_KEY: "k", AGGREGATOR_PROVIDERS: "tiktok" });
    expect(s.youtube).toMatchObject({ configured: true, missing: [], viaAggregator: false });
    expect(s.x).toMatchObject({ configured: false, missing: ["X_CLIENT_SECRET"] });
    expect(s.linkedin.missing).toEqual(["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"]);
    expect(s.tiktok).toMatchObject({ configured: true, viaAggregator: true, missing: [] });
    expect(s.instagram.missing).toEqual(["META_APP_ID", "META_APP_SECRET"]);
    expect(JSON.stringify(s)).not.toContain("only-id");
  });

  it("sandboxMode follows KLIPZ_PUBLISH_MOCK", () => {
    expect(sandboxMode({ KLIPZ_PUBLISH_MOCK: "1" })).toBe(true);
    expect(sandboxMode({ KLIPZ_PUBLISH_MOCK: "0" })).toBe(false);
    expect(sandboxMode({})).toBe(false);
  });
});
