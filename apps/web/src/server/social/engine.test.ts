import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishError, type Publisher } from "@klipz/publishers";
import type { Provider } from "@klipz/shared";
import { setupTestEnv, cleanup, freshDb, seedClip, addAccount, fakePublisher, type Seed } from "./test-helpers";

const tmp = setupTestEnv("engine");

import { get, run } from "../db";
import { getPost } from "../repo";
import { PostInputSchema, createPosts, type PostInput } from "./posts";
import { LOCK_TTL_MS, POLL_DELAY_MS, processDuePosts, type EngineDeps } from "./engine";
import { loadTokens } from "./vault";

afterAll(() => cleanup(tmp));

let seed: Seed;
beforeEach(() => {
  freshDb(tmp);
  seed = seedClip();
});

const T0 = new Date("2026-06-01T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SEC = 1000, MIN = 60_000;

const input = (accountIds: string[], extra: Partial<PostInput> = {}): PostInput =>
  PostInputSchema.parse({ clipId: seed.clipId, renderId: seed.renderId, accountIds, caption: "Hello", hashtags: [], ...extra });

/** creates posts with a permissive validator (validation is covered in posts.test.ts) */
const create = (accountIds: string[], extra: Partial<PostInput> = {}, now = T0) => createPosts(input(accountIds, extra), now, { publisherFor: (p) => fakePublisher(p) }).posts;

const deps = (pubs: Partial<Record<Provider, Publisher>> = {}, extra: EngineDeps = {}): EngineDeps => ({
  publisherFor: (p) => pubs[p] ?? fakePublisher(p),
  backoff: { baseMs: 60_000, maxMs: 3_600_000, jitter: () => 0 },
  ...extra,
});

describe("promotion + success", () => {
  it("promotes scheduled posts only once due, then publishes", async () => {
    const x = addAccount("x");
    const [p] = create([x.id], { scheduledAt: at(60 * MIN).toISOString() });
    let s = await processDuePosts(at(59 * MIN), deps());
    expect(s.promoted).toBe(0);
    expect(getPost(p!.id)!.status).toBe("scheduled");
    s = await processDuePosts(at(61 * MIN), deps());
    expect(s).toMatchObject({ promoted: 1, processed: 1, published: 1 });
    expect(getPost(p!.id)).toMatchObject({ status: "published", external_id: "ext_x_1", external_url: "https://example.invalid/x/1", attempts: 1, published_at: at(61 * MIN).toISOString(), error: null });
  });

  it("passes an absolute file path, render facts and the composed PostMeta to the publisher", async () => {
    const yt = addAccount("youtube");
    create([yt.id], { caption: "Cap", hashtags: ["a"], title: "T", coverTimestampMs: 1500, options: { youtube: { privacy: "unlisted" } } });
    const publish = vi.fn(async () => ({ externalId: "v1", status: "published" as const }));
    await processDuePosts(T0, deps({ youtube: fakePublisher("youtube", { publish }) }));
    const call = (publish.mock.calls[0] as unknown as [unknown, { render: { filePath: string; width: number; durationSec: number; videoCodec: string }; meta: object; account: { externalAccountId: string }; tokens: { accessToken: string } }])[1];
    expect(call.render.filePath).toMatch(/clip\.mp4$/);
    expect(call.render.filePath).toMatch(/^([A-Za-z]:|\/)/);
    expect(call.render).toMatchObject({ width: 1080, durationSec: 8, videoCodec: "h264" });
    expect(call.meta).toEqual({ caption: "Cap", hashtags: ["a"], title: "T", coverTimestampMs: 1500, options: { privacy: "unlisted" } });
    expect(call.tokens.accessToken).toBe("AT-youtube");
    expect(call.account.externalAccountId).toBe("ext-youtube");
  });

  it("does not touch posts whose next_attempt_at is in the future", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    run("update posts set next_attempt_at = ? where id = ?", at(5 * MIN).toISOString(), p!.id);
    expect((await processDuePosts(T0, deps())).processed).toBe(0);
    expect((await processDuePosts(at(5 * MIN), deps())).processed).toBe(1);
  });
});

describe("processing -> poll", () => {
  it("polls on later ticks and persists a changed external id (Instagram container -> media id)", async () => {
    const ig = addAccount("instagram");
    const [p] = create([ig.id]);
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "processing" })
      .mockResolvedValueOnce({ status: "published", url: "https://ig/reel/9", externalId: "media9" });
    const pub = fakePublisher("instagram", { publish: async () => ({ externalId: "container:77", status: "processing" }), getStatus });
    let s = await processDuePosts(T0, deps({ instagram: pub }));
    expect(s.processing).toBe(1);
    expect(getPost(p!.id)).toMatchObject({ status: "processing", external_id: "container:77", attempts: 1, next_attempt_at: at(POLL_DELAY_MS).toISOString() });
    // too early: not polled
    expect((await processDuePosts(at(POLL_DELAY_MS - SEC), deps({ instagram: pub }))).processed).toBe(0);
    s = await processDuePosts(at(POLL_DELAY_MS), deps({ instagram: pub }));
    expect(s.processing).toBe(1);
    expect(getPost(p!.id)!.status).toBe("processing");
    s = await processDuePosts(at(2 * POLL_DELAY_MS), deps({ instagram: pub }));
    expect(s.published).toBe(1);
    expect(getPost(p!.id)).toMatchObject({ status: "published", external_id: "media9", external_url: "https://ig/reel/9", attempts: 1 });
    expect(getStatus.mock.calls[0]![1].externalId).toBe("container:77");
    expect(getStatus.mock.calls[1]![1].externalId).toBe("container:77");
  });

  it("a platform-reported failure ends the post as failed/platform_failed", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const pub = fakePublisher("x", { publish: async () => ({ externalId: "e1", status: "processing" }), getStatus: async () => ({ status: "failed", error: "bad codec" }) });
    await processDuePosts(T0, deps({ x: pub }));
    await processDuePosts(at(POLL_DELAY_MS), deps({ x: pub }));
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "platform_failed", error: "bad codec", external_id: "e1" });
  });

  it("a post that already has an external id is only polled, never published again", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    run("update posts set external_id = 'already', status = 'queued' where id = ?", p!.id);
    const publish = vi.fn();
    const s = await processDuePosts(T0, deps({ x: fakePublisher("x", { publish, getStatus: async () => ({ status: "published", url: "u" }) }) }));
    expect(publish).not.toHaveBeenCalled();
    expect(s.published).toBe(1);
    expect(getPost(p!.id)).toMatchObject({ status: "published", external_id: "already" });
  });
});

describe("retry / backoff", () => {
  it("retryable errors back off exponentially per post and end failed at max_attempts", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    run("update posts set max_attempts = 3 where id = ?", p!.id);
    const publish = vi.fn(async () => {
      throw new PublishError("503 from platform", { code: "server_error", retryable: true });
    });
    const d = deps({ x: fakePublisher("x", { publish }) });
    let s = await processDuePosts(T0, d);
    expect(s.retried).toBe(1);
    // jitter 0 => half of base*2^(n-1): attempt 1 -> 30 s, attempt 2 -> 60 s
    expect(getPost(p!.id)).toMatchObject({ status: "queued", attempts: 1, error_code: "server_error", next_attempt_at: at(30 * SEC).toISOString() });
    expect((await processDuePosts(at(29 * SEC), d)).processed).toBe(0);
    await processDuePosts(at(30 * SEC), d);
    expect(getPost(p!.id)).toMatchObject({ status: "queued", attempts: 2, next_attempt_at: at(30 * SEC + 60 * SEC).toISOString() });
    s = await processDuePosts(at(90 * SEC), d);
    expect(s.failed).toBe(1);
    expect(getPost(p!.id)).toMatchObject({ status: "failed", attempts: 3, next_attempt_at: null, error_code: "server_error" });
    expect(getPost(p!.id)!.error).toMatch(/gave up after 3 attempts/);
    expect(publish).toHaveBeenCalledTimes(3);
    expect((await processDuePosts(at(24 * 60 * MIN), d)).processed).toBe(0);
  });

  it("honours retryAfterSec when it is longer than the backoff", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const pub = fakePublisher("x", { publish: async () => { throw new PublishError("429", { code: "rate_limited", retryable: true, retryAfterSec: 900 }); } });
    await processDuePosts(T0, deps({ x: pub }));
    expect(getPost(p!.id)!.next_attempt_at).toBe(at(900 * SEC).toISOString());
  });

  it("a non-retryable error fails immediately with its code", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const pub = fakePublisher("x", { publish: async () => { throw new PublishError("rejected", { code: "content_rejected" }); } });
    await processDuePosts(T0, deps({ x: pub }));
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "content_rejected", attempts: 1, error: "rejected" });
  });

  it("an unknown (non-PublishError) failure is NOT retried automatically", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const publish = vi.fn(async () => { throw new Error("socket hang up"); });
    await processDuePosts(T0, deps({ x: fakePublisher("x", { publish }) }));
    await processDuePosts(at(10 * MIN), deps({ x: fakePublisher("x", { publish }) }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "unexpected_error" });
  });
});

describe("accounts + tokens", () => {
  it("needsReconnect marks the account and fails the post; later posts on that account fail fast without publishing", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const publish = vi.fn(async () => { throw new PublishError("token revoked", { code: "auth_invalid", needsReconnect: true }); });
    const pub = fakePublisher("x", { publish });
    await processDuePosts(T0, deps({ x: pub }));
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "needs_reconnect" });
    expect(get("select status, last_error from social_accounts where id = ?", x.id)).toMatchObject({ status: "needs_reconnect", last_error: "token revoked" });
    // second post created while the account is flagged cannot be validated; insert directly as if queued before the flag
    run("insert into posts (id, batch_id, clip_id, render_id, social_account_id, provider, status, next_attempt_at) values ('late', 'b', ?, ?, ?, 'x', 'queued', ?)", seed.clipId, seed.renderId, x.id, at(MIN).toISOString());
    await processDuePosts(at(MIN), deps({ x: pub }));
    expect(publish).toHaveBeenCalledTimes(1);
    expect(getPost("late")).toMatchObject({ status: "failed", error_code: "needs_reconnect" });
  });

  it("refresh failing with needsReconnect flags the account and never calls publish", async () => {
    const yt = addAccount("youtube", "y1", { accessToken: "OLD", refreshToken: "R", expiresAt: at(-MIN).toISOString() });
    const [p] = create([yt.id]);
    const publish = vi.fn();
    const pub = fakePublisher("youtube", { publish, refresh: async () => { throw new PublishError("invalid_grant", { code: "auth_invalid", needsReconnect: true }); } });
    await processDuePosts(T0, deps({ youtube: pub }));
    expect(publish).not.toHaveBeenCalled();
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "needs_reconnect" });
    expect(get("select status from social_accounts where id = ?", yt.id)).toEqual({ status: "needs_reconnect" });
  });

  it("persists rotated tokens (encrypted) and publishes with the fresh access token", async () => {
    const x = addAccount("x", "x1", { accessToken: "OLD", refreshToken: "R1", expiresAt: at(2 * MIN).toISOString() }); // inside the 5 min skew
    create([x.id]);
    const publish = vi.fn(async () => ({ externalId: "e", status: "published" as const }));
    const refresh = vi.fn(async () => ({ accessToken: "NEW", refreshToken: "R2", expiresAt: at(2 * 60 * MIN).toISOString(), scopes: ["s"] }));
    await processDuePosts(T0, deps({ x: fakePublisher("x", { publish, refresh }) }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((publish.mock.calls[0] as unknown as [unknown, { tokens: { accessToken: string } }])[1].tokens.accessToken).toBe("NEW");
    expect(loadTokens(x.id)).toMatchObject({ accessToken: "NEW", refreshToken: "R2", expiresAt: at(2 * 60 * MIN).toISOString() });
    const raw = get<{ access_token_enc: string; refresh_token_enc: string }>("select access_token_enc, refresh_token_enc from social_accounts where id = ?", x.id)!;
    expect(raw.access_token_enc + raw.refresh_token_enc).not.toMatch(/NEW|R2/);
  });

  it("does not refresh a token that is still fresh", async () => {
    const x = addAccount("x", "x1", { accessToken: "A", refreshToken: "R", expiresAt: at(2 * 60 * MIN).toISOString() });
    create([x.id]);
    const refresh = vi.fn();
    await processDuePosts(T0, deps({ x: fakePublisher("x", { refresh }) }));
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("batch independence", () => {
  it("one platform failing never blocks or fails the others", async () => {
    const accs = (["youtube", "x", "linkedin", "facebook"] as Provider[]).map((p) => addAccount(p));
    const posts = create(accs.map((a) => a.id));
    const pubs: Partial<Record<Provider, Publisher>> = {
      x: fakePublisher("x", { publish: async () => { throw new PublishError("nope", { code: "content_rejected" }); } }),
      facebook: fakePublisher("facebook", { publish: async () => { throw new PublishError("503", { code: "server_error", retryable: true }); } }),
    };
    const s = await processDuePosts(T0, deps(pubs));
    expect(s).toMatchObject({ processed: 4, published: 2, failed: 1, retried: 1 });
    const byProvider = Object.fromEntries(posts.map((p) => [p.provider, getPost(p.id)!]));
    expect(byProvider.youtube!.status).toBe("published");
    expect(byProvider.linkedin!.status).toBe("published");
    expect(byProvider.x).toMatchObject({ status: "failed", error_code: "content_rejected" });
    expect(byProvider.facebook).toMatchObject({ status: "queued", attempts: 1 });
    expect(new Set(posts.map((p) => p.batch_id)).size).toBe(1);
  });
});

describe("crash safety + locks", () => {
  it("never publishes twice when the process dies between publish() and the DB write", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const publish = vi.fn(async () => ({ externalId: "real-id", status: "published" as const }));
    const pub = fakePublisher("x", { publish });
    const crash: EngineDeps = { afterPublishCall: () => { throw new Error("simulated crash"); } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await processDuePosts(T0, deps({ x: pub }, crash));
    spy.mockRestore();
    expect(s.results[0]!.outcome).toBe("crashed");
    expect(getPost(p!.id)).toMatchObject({ status: "publishing", external_id: null, error_code: "in_flight" });
    // restart: fresh lock is respected, nothing is published again
    await processDuePosts(at(MIN), deps({ x: pub }));
    expect(publish).toHaveBeenCalledTimes(1);
    // lock expires: marked uncertain, still not re-published
    const s2 = await processDuePosts(at(LOCK_TTL_MS + MIN), deps({ x: pub }));
    expect(s2.reclaimed).toBe(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "uncertain_outcome" });
    expect(getPost(p!.id)!.error).toMatch(/may or may not/);
  });

  it("reclaims a stale lock that held a post which never started publishing", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    run("update posts set status = 'publishing', locked_at = ?, error_code = null where id = ?", T0.toISOString(), p!.id);
    expect((await processDuePosts(at(LOCK_TTL_MS - MIN), deps())).processed).toBe(0);
    const s = await processDuePosts(at(LOCK_TTL_MS + MIN), deps());
    expect(s.reclaimed).toBe(1);
    expect(s.published).toBe(1);
    expect(getPost(p!.id)!.status).toBe("published");
  });

  it("a stale lock on a post that already has an external id resumes polling", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    run("update posts set status = 'publishing', locked_at = ?, external_id = 'e5' where id = ?", T0.toISOString(), p!.id);
    const publish = vi.fn();
    const s = await processDuePosts(at(LOCK_TTL_MS + MIN), deps({ x: fakePublisher("x", { publish }) }));
    expect(publish).not.toHaveBeenCalled();
    expect(s.published).toBe(1);
  });

  it("a fresh lock is never claimed twice (two ticks racing)", async () => {
    const x = addAccount("x");
    create([x.id]);
    const publish = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { externalId: "e", status: "published" as const };
    });
    const pub = fakePublisher("x", { publish });
    await Promise.all([processDuePosts(T0, deps({ x: pub })), processDuePosts(T0, deps({ x: pub }))]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("a deleted render or disconnected account fails with a clear code", async () => {
    const x = addAccount("x"), li = addAccount("linkedin");
    const posts = create([x.id, li.id]);
    run("delete from social_accounts where id = ?", li.id);
    run("update renders set status = 'failed' where id = ?", seed.renderId);
    await processDuePosts(T0, deps());
    expect(getPost(posts.find((p) => p.provider === "linkedin")!.id)).toMatchObject({ status: "failed", error_code: "account_missing" });
    expect(getPost(posts.find((p) => p.provider === "x")!.id)).toMatchObject({ status: "failed", error_code: "render_missing" });
  });

  it("gives up polling after the processing timeout", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const pub = fakePublisher("x", { publish: async () => ({ externalId: "e1", status: "processing" }), getStatus: async () => ({ status: "processing" }) });
    run("update posts set created_at = ? where id = ?", T0.toISOString(), p!.id);
    await processDuePosts(T0, deps({ x: pub }));
    await processDuePosts(at(7 * 60 * MIN), deps({ x: pub }));
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "processing_timeout" });
  });
});

describe("review fixes", () => {
  it("fails with render_missing (no publish call) when the mp4 is gone from disk", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const { storagePath } = await import("../paths");
    const fsm = await import("node:fs");
    fsm.rmSync(storagePath(`renders/${seed.renderId}/clip.mp4`));
    const publish = vi.fn();
    await processDuePosts(T0, deps({ x: fakePublisher("x", { publish }) }));
    expect(publish).not.toHaveBeenCalled();
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "render_missing" });
  });

  it("never stores a non-http(s) external url", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const pub = fakePublisher("x", { publish: async () => ({ externalId: "e1", status: "published", url: "javascript:alert(1)" }) });
    await processDuePosts(T0, deps({ x: pub }));
    expect(getPost(p!.id)).toMatchObject({ status: "published", external_id: "e1", external_url: null });
  });
});

const lockOf = (id: string) => get<{ locked_at: string | null }>("select locked_at from posts where id = ?", id)!.locked_at;

describe("lock heartbeat", () => {
  it("keeps the lock fresh during a long upload so a concurrent tick does not reclaim it, and never publishes twice", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const publish = vi.fn(async () => {
      await gate;
      return { externalId: "slow-1", status: "published" as const };
    });
    const pub = fakePublisher("x", { publish });
    let clock = T0;
    const beat: EngineDeps = { heartbeatMs: 5, clock: () => clock };
    const first = processDuePosts(T0, deps({ x: pub }, beat));
    // the upload has been running far longer than the lock TTL (fake clock), heartbeat must have refreshed locked_at
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    clock = at(LOCK_TTL_MS + 5 * MIN);
    await vi.waitFor(() => expect(lockOf(p!.id)).toBe(clock.toISOString()));
    const s2 = await processDuePosts(at(LOCK_TTL_MS + 6 * MIN), deps({ x: pub }));
    expect(s2.reclaimed).toBe(0);
    expect(getPost(p!.id)!.status).toBe("publishing");
    release();
    await first;
    expect(getPost(p!.id)).toMatchObject({ status: "published", external_id: "slow-1", locked_at: null });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("stops beating once publish returns (a crashed run is still reclaimed as uncertain)", async () => {
    const x = addAccount("x");
    const [p] = create([x.id]);
    const pub = fakePublisher("x", { publish: async () => ({ externalId: "e", status: "published" as const }) });
    const crash: EngineDeps = { heartbeatMs: 5, afterPublishCall: () => { throw new Error("boom"); } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await processDuePosts(T0, deps({ x: pub }, crash));
    spy.mockRestore();
    const lockAfter = lockOf(p!.id);
    await new Promise((r) => setTimeout(r, 40));
    expect(lockOf(p!.id)).toBe(lockAfter);
    await processDuePosts(at(LOCK_TTL_MS + MIN), deps({ x: pub }));
    expect(getPost(p!.id)).toMatchObject({ status: "failed", error_code: "uncertain_outcome" });
  });
});
