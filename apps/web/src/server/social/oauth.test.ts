import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { signState } from "@klipz/publishers";
import { setupTestEnv, cleanup, freshDb, fakePublisher } from "./test-helpers";

const tmp = setupTestEnv("oauth");

import { all, get, run } from "../db";
import { listAccounts } from "../repo";
import { beginOAuth, completeOAuth, OAUTH_COOKIE } from "./oauth";
import { disconnectAccount, createSandboxAccount } from "./accounts";
import { loadTokens } from "./vault";
import { newId } from "../db";
import { HttpError } from "../http";

afterAll(() => cleanup(tmp));
beforeEach(() => freshDb(tmp));

const ctx = { config: { clientId: "cid", clientSecret: "csec", redirectUri: "http://localhost:3000/api/oauth/facebook/callback" } };
const SECRET = "test-state-secret";

const facebook = () =>
  fakePublisher("facebook", {
    connect: async (_c, a) => {
      expect(a.code).toBe("the-code");
      expect(a.codeVerifier).toBeTruthy();
      return {
        tokens: { accessToken: "USER-TOKEN", refreshToken: "USER-REFRESH", scopes: ["pages_show_list"], expiresAt: "2030-01-01T00:00:00.000Z" },
        accounts: [
          { externalAccountId: "page1", displayName: "Page One", meta: { pageId: "page1" } },
          { externalAccountId: "page2", displayName: "Page Two", meta: { pageId: "page2" } },
        ],
        accountTokens: { page1: { accessToken: "PAGE1-TOKEN", scopes: ["pages_manage_posts"] }, page2: { accessToken: "PAGE2-TOKEN", scopes: [] } },
      };
    },
  });

async function begin() {
  const r = await beginOAuth("facebook", { publisher: facebook(), ctx, secret: SECRET });
  const cookie = JSON.parse(Buffer.from(r.cookieValue!, "base64url").toString()) as { state: string; codeVerifier: string };
  return { r, cookie };
}

describe("oauth start", () => {
  it("returns the provider URL carrying a signed state, plus the cookie payload", async () => {
    const { r, cookie } = await begin();
    expect(r.redirectTo).toContain("https://auth.example/facebook");
    expect(r.redirectTo).toContain(encodeURIComponent(cookie.state));
    expect(cookie.codeVerifier.length).toBeGreaterThan(20);
    expect(OAUTH_COOKIE).toBe("klipz_oauth");
  });

  it("refuses an unconfigured provider", async () => {
    await expect(beginOAuth("x", { publisher: fakePublisher("x") })).rejects.toBeInstanceOf(HttpError);
  });
});

describe("oauth callback", () => {
  it("upserts every account, page tokens win, tokens encrypted at rest, nothing secret in the redirect", async () => {
    const { r, cookie } = await begin();
    const out = await completeOAuth("facebook", { code: "the-code", state: cookie.state, cookieValue: r.cookieValue }, { publisher: facebook(), ctx, secret: SECRET });
    expect(out).toEqual({ redirectTo: "/accounts?connected=facebook&n=2", connected: 2 });
    expect(out.redirectTo).not.toMatch(/TOKEN|REFRESH|code/);
    const accounts = listAccounts();
    expect(accounts.map((a) => a.external_account_id).sort()).toEqual(["page1", "page2"]);
    expect(accounts.every((a) => a.status === "active")).toBe(true);
    expect(JSON.stringify(accounts)).not.toMatch(/TOKEN|REFRESH|_enc/);
    const p1 = accounts.find((a) => a.external_account_id === "page1")!;
    expect(loadTokens(p1.id)).toMatchObject({ accessToken: "PAGE1-TOKEN" });
    const raw = all<{ access_token_enc: string; refresh_token_enc: string | null }>("select access_token_enc, refresh_token_enc from social_accounts");
    for (const row of raw) expect(JSON.stringify(row)).not.toMatch(/TOKEN/);
  });

  it("reconnecting updates the same row (no duplicate) and reactivates it", async () => {
    const { r, cookie } = await begin();
    await completeOAuth("facebook", { code: "the-code", state: cookie.state, cookieValue: r.cookieValue }, { publisher: facebook(), ctx, secret: SECRET });
    run("update social_accounts set status = 'needs_reconnect', last_error = 'x'");
    const again = await begin();
    await completeOAuth("facebook", { code: "the-code", state: again.cookie.state, cookieValue: again.r.cookieValue }, { publisher: facebook(), ctx, secret: SECRET });
    const rows = all<{ status: string; last_error: string | null }>("select status, last_error from social_accounts");
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.status === "active" && x.last_error === null)).toBe(true);
  });

  const expectError = (out: { redirectTo: string; connected: number }, re: RegExp) => {
    expect(out.connected).toBe(0);
    expect(out.redirectTo.startsWith("/accounts?error=")).toBe(true);
    expect(new URLSearchParams(out.redirectTo.split("?")[1]).get("error")).toMatch(re);
    expect(get("select count(*) as n from social_accounts")).toMatchObject({ n: 0 });
  };

  it("rejects a state that differs from the cookie", async () => {
    const { r } = await begin();
    const other = signState({ workspaceId: "local", provider: "facebook" }, SECRET);
    expectError(await completeOAuth("facebook", { code: "the-code", state: other, cookieValue: r.cookieValue }, { publisher: facebook(), ctx, secret: SECRET }), /State mismatch/);
  });

  it("rejects a forged state even when the cookie matches", async () => {
    const forged = signState({ workspaceId: "local", provider: "facebook" }, "attacker-secret");
    const cookieValue = Buffer.from(JSON.stringify({ state: forged, codeVerifier: "v", provider: "facebook" })).toString("base64url");
    expectError(await completeOAuth("facebook", { code: "c", state: forged, cookieValue }, { publisher: facebook(), ctx, secret: SECRET }), /Invalid OAuth state/);
  });

  it("rejects an expired state", async () => {
    const old = signState({ workspaceId: "local", provider: "facebook" }, SECRET, { ttlSec: 600, now: () => new Date(Date.now() - 3600_000) });
    const cookieValue = Buffer.from(JSON.stringify({ state: old, codeVerifier: "v", provider: "facebook" })).toString("base64url");
    expectError(await completeOAuth("facebook", { code: "c", state: old, cookieValue }, { publisher: facebook(), ctx, secret: SECRET }), /expired/);
  });

  it("handles missing cookie, missing code and provider errors", async () => {
    const { cookie } = await begin();
    expectError(await completeOAuth("facebook", { code: "c", state: cookie.state, cookieValue: null }, { publisher: facebook(), ctx, secret: SECRET }), /expired|start again/);
    expectError(await completeOAuth("facebook", { state: cookie.state }, { publisher: facebook(), ctx, secret: SECRET }), /Missing code/);
    expectError(await completeOAuth("facebook", { error: "access_denied" }, { publisher: facebook(), ctx, secret: SECRET }), /access_denied/);
  });

  it("turns connect() failures into a short error redirect without secrets", async () => {
    const { r, cookie } = await begin();
    const bad = fakePublisher("facebook", {
      connect: async () => {
        throw new Error("exchange failed access_token=SECRETVALUE123 more");
      },
    });
    const out = await completeOAuth("facebook", { code: "c", state: cookie.state, cookieValue: r.cookieValue }, { publisher: bad, ctx, secret: SECRET });
    expectError(out, /exchange failed/);
    expect(out.redirectTo).not.toContain("SECRETVALUE123");
    expect(out.redirectTo.length).toBeLessThan(260);
  });
});

describe("sandbox connect is POST-only", () => {
  it("beginOAuth without allowCreate (what a GET does) creates nothing in sandbox mode", async () => {
    process.env.KLIPZ_PUBLISH_MOCK = "1";
    try {
      const r = await beginOAuth("tiktok");
      expect(r.redirectTo).toBe("/accounts?connect=tiktok");
      expect(r.cookieValue).toBeUndefined();
      expect(listAccounts()).toHaveLength(0);
      const created = await beginOAuth("tiktok", { allowCreate: true });
      expect(created.redirectTo).toContain("connected=tiktok");
      expect(listAccounts()).toHaveLength(1);
    } finally {
      delete process.env.KLIPZ_PUBLISH_MOCK;
    }
  });
});

describe("accounts", () => {
  it("disconnect deletes the account and posts keep history", () => {
    process.env.KLIPZ_PUBLISH_MOCK = "1";
    try {
      const acc = createSandboxAccount("youtube");
      expect(acc).toMatchObject({ provider: "youtube", status: "active", display_name: "Sandbox Youtube" });
      const projectId = newId(), srcId = newId(), clipId = newId(), postId = newId();
      run("insert into projects (id, title) values (?, 'p')", projectId);
      run("insert into source_videos (id, project_id, origin, status) values (?, ?, 'upload', 'ready')", srcId, projectId);
      run("insert into clips (id, project_id, source_video_id, start_sec, end_sec) values (?, ?, ?, 0, 5)", clipId, projectId, srcId);
      run("insert into posts (id, batch_id, clip_id, social_account_id, provider, status) values (?, 'b', ?, ?, 'youtube', 'published')", postId, clipId, acc.id);
      expect(disconnectAccount(acc.id)).toBe(true);
      expect(disconnectAccount(acc.id)).toBe(false);
      expect(get("select social_account_id from posts where id = ?", postId)).toEqual({ social_account_id: null });
    } finally {
      delete process.env.KLIPZ_PUBLISH_MOCK;
    }
  });

  it("sandbox accounts are refused when sandbox mode is off", () => {
    expect(() => createSandboxAccount("x")).toThrow(/Sandbox mode is off/);
  });
});
