import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestEnv, cleanup, freshDb, seedClip, addAccount, type Seed } from "./test-helpers";

const tmp = setupTestEnv("posts");

import { get, run, all, newId } from "../db";
import { HttpError } from "../http";
import { PostInputSchema, ValidationFailed, applyPostAction, createPosts, deletePost, getPostView, listPostViews, validatePosts, type PostInput } from "./posts";
import { mockPublisher, resetMockState } from "./mock";

afterAll(() => cleanup(tmp));

let seed: Seed;
beforeEach(() => {
  freshDb(tmp);
  resetMockState();
  seed = seedClip();
});

const deps = { publisherFor: mockPublisher };
const input = (accountIds: string[], extra: Partial<PostInput> = {}): PostInput =>
  PostInputSchema.parse({ clipId: seed.clipId, renderId: seed.renderId, accountIds, caption: "Hello world", hashtags: ["klipz"], ...extra });
const NOW = new Date("2026-06-01T12:00:00.000Z");

describe("createPosts", () => {
  it("fans out one row per account sharing a batch_id (queued now)", () => {
    const yt = addAccount("youtube"), x = addAccount("x"), li = addAccount("linkedin");
    const { batchId, posts } = createPosts(input([yt.id, x.id, li.id]), NOW, deps);
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((p) => p.batch_id))).toEqual(new Set([batchId]));
    expect(posts.map((p) => p.provider).sort()).toEqual(["linkedin", "x", "youtube"]);
    for (const p of posts) expect(p).toMatchObject({ status: "queued", next_attempt_at: NOW.toISOString(), attempts: 0, max_attempts: 6, render_id: seed.renderId, hashtags: ["klipz"] });
  });

  it("future scheduledAt creates 'scheduled' rows with the timezone; past/now is queued", () => {
    const x = addAccount("x");
    const when = "2026-06-02T09:00:00.000Z";
    const a = createPosts(input([x.id], { scheduledAt: when, timezone: "Europe/Berlin" }), NOW, deps).posts[0]!;
    expect(a).toMatchObject({ status: "scheduled", scheduled_at: when, timezone: "Europe/Berlin", next_attempt_at: null });
    const b = createPosts(input([x.id], { scheduledAt: "2026-05-01T00:00:00.000Z" }), NOW, deps).posts[0]!;
    expect(b.status).toBe("queued");
  });

  it("blocks everything with per-account issues when ANY account has an error (nothing is written)", () => {
    const yt = addAccount("youtube"), tt = addAccount("tiktok");
    try {
      createPosts(input([yt.id, tt.id]), NOW, deps);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationFailed);
      const issues = (e as ValidationFailed).issues;
      expect(issues[yt.id]!.filter((i) => i.severity === "error")).toHaveLength(0);
      expect(issues[tt.id]!.map((i) => i.code)).toEqual(expect.arrayContaining(["privacy_required", "consent_required"]));
    }
    expect(get("select count(*) as n from posts")).toEqual({ n: 0 });
  });

  it("per-provider options and per-account overrides are merged and stored", () => {
    const tt = addAccount("tiktok"), x = addAccount("x");
    const { posts } = createPosts(
      input([tt.id, x.id], {
        options: { tiktok: { privacyLevel: "SELF_ONLY", consentAccepted: true } },
        overrides: { [x.id]: { caption: "short for x", hashtags: ["a", "b"] }, [tt.id]: { options: { disableComment: true }, title: "TT title" } },
      }),
      NOW,
      deps,
    );
    const ptt = posts.find((p) => p.provider === "tiktok")!, px = posts.find((p) => p.provider === "x")!;
    expect(ptt.options).toMatchObject({ privacyLevel: "SELF_ONLY", consentAccepted: true, disableComment: true });
    expect(ptt.caption).toBe("Hello world");
    expect(ptt.title).toBe("TT title");
    expect(px).toMatchObject({ caption: "short for x", hashtags: ["a", "b"] });
  });

  it("rejects unknown accounts, foreign / unready renders, missing files, and accounts that need reconnect", () => {
    const x = addAccount("x");
    expect(() => createPosts(input(["nope"]), NOW, deps)).toThrow(HttpError);
    const other = seedClip();
    expect(() => createPosts(input([x.id], { renderId: other.renderId }), NOW, deps)).toThrow(/does not belong/);
    run("update renders set status = 'rendering' where id = ?", seed.renderId);
    expect(() => createPosts(input([x.id]), NOW, deps)).toThrow(/not ready/);
    run("update renders set status = 'ready' where id = ?", seed.renderId);
    const noFile = seedClip({ withFile: false });
    expect(() => createPosts(input([x.id], { clipId: noFile.clipId, renderId: noFile.renderId }), NOW, deps)).toThrow(ValidationFailed);
    run("update social_accounts set status = 'needs_reconnect' where id = ?", x.id);
    expect(() => createPosts(input([x.id]), NOW, deps)).toThrow(ValidationFailed);
  });

  it("rejects a render that fails platform limits (too long for Facebook) for that account only in the report", () => {
    const long = seedClip({ durationSec: 200 });
    const fb = addAccount("facebook"), li = addAccount("linkedin");
    try {
      createPosts(input([fb.id, li.id], { clipId: long.clipId, renderId: long.renderId }), NOW, deps);
      throw new Error("no throw");
    } catch (e) {
      const issues = (e as ValidationFailed).issues;
      expect(issues[fb.id]!.some((i) => i.severity === "error")).toBe(true);
      expect(issues[li.id]!.some((i) => i.severity === "error")).toBe(false);
    }
  });
});

describe("validatePosts", () => {
  it("returns issues and the caption exactly as it will be composed, with length and limit, and writes nothing", () => {
    const x = addAccount("x"), yt = addAccount("youtube");
    const r = validatePosts(input([x.id, yt.id], { caption: "w ".repeat(300), hashtags: ["one", "two"], title: "My title" }), deps);
    expect(r.composed[x.id]!.limit).toBe(280);
    expect(r.composed[x.id]!.length).toBeLessThanOrEqual(280);
    expect(r.composed[yt.id]).toMatchObject({ limit: 5000, title: "My title #Shorts" });
    expect(r.composed[yt.id]!.caption).toContain("#Shorts");
    expect(get("select count(*) as n from posts")).toEqual({ n: 0 });
  });
});

describe("listing + actions", () => {
  it("joins account, clip title, cover key and latest metrics", () => {
    const x = addAccount("x");
    const { posts, batchId } = createPosts(input([x.id]), NOW, deps);
    const id = posts[0]!.id;
    run("insert into post_metrics (post_id, captured_on, views, likes) values (?, '2026-06-01', 5, 1), (?, '2026-06-02', 9, 2)", id, id);
    const v = listPostViews({ batchId })[0]!;
    expect(v).toMatchObject({ clip_title: "Clip title", cover_key: `renders/${seed.renderId}/cover.jpg`, account: { display_name: "Acc x" }, metrics: { views: 9, likes: 2 } });
    expect(JSON.stringify(v)).not.toMatch(/locked_at|_enc/);
    expect(listPostViews({ status: "failed" })).toHaveLength(0);
    expect(listPostViews({ clipId: seed.clipId, status: "queued,failed" })).toHaveLength(1);
    expect(getPostView(id)?.id).toBe(id);
  });

  const make = (status: string, extra = "") => {
    const x = addAccount("x");
    const id = newId();
    run(`insert into posts (id, batch_id, clip_id, render_id, social_account_id, provider, status${extra ? ", " + extra.split("=")[0] : ""}) values (?, 'b', ?, ?, ?, 'x', ?${extra ? ", " + extra.split("=")[1] : ""})`, id, seed.clipId, seed.renderId, x.id, status);
    return id;
  };

  it("retry: failed -> queued with attempts reset", () => {
    const id = make("failed");
    run("update posts set attempts = 4, error = 'boom', error_code = 'server_error' where id = ?", id);
    const p = applyPostAction(id, { action: "retry" }, NOW);
    expect(p).toMatchObject({ status: "queued", attempts: 0, error: null, error_code: null, next_attempt_at: NOW.toISOString() });
    expect(() => applyPostAction(id, { action: "retry" }, NOW)).toThrow(/Only failed/);
  });

  it("retry with a corrected caption stores it, but never edits a post that is already on the platform", () => {
    const id = make("failed");
    run("update posts set caption = 'bad [fail-hard]', error_code = 'content_rejected' where id = ?", id);
    expect(applyPostAction(id, { action: "retry", caption: "fixed text" }, NOW)).toMatchObject({ status: "queued", caption: "fixed text" });
    const id2 = make("failed");
    run("update posts set caption = 'orig', external_id = 'abc', error_code = 'needs_reconnect' where id = ?", id2);
    expect(() => applyPostAction(id2, { action: "retry", caption: "new" }, NOW)).toThrow(/already on the platform/);
    expect(get<{ caption: string }>("select caption from posts where id = ?", id2)?.caption).toBe("orig");
  });

  it("retry never re-publishes something the platform already has", () => {
    const id = make("failed");
    run("update posts set external_id = 'abc', error_code = 'unexpected_error' where id = ?", id);
    expect(() => applyPostAction(id, { action: "retry" }, NOW)).toThrow(/already sent/);
    run("update posts set error_code = 'needs_reconnect' where id = ?", id);
    expect(applyPostAction(id, { action: "retry" }, NOW)).toMatchObject({ status: "processing", external_id: "abc" });
    const id2 = make("failed");
    run("update posts set external_id = 'zzz', error_code = 'platform_failed' where id = ?", id2);
    expect(applyPostAction(id2, { action: "retry" }, NOW)).toMatchObject({ status: "queued", external_id: null });
  });

  it("cancel: scheduled/queued only", () => {
    const a = make("scheduled"), b = make("queued"), c = make("published"), d = make("publishing");
    expect(applyPostAction(a, { action: "cancel" }).status).toBe("cancelled");
    expect(applyPostAction(b, { action: "cancel" }).status).toBe("cancelled");
    expect(() => applyPostAction(c, { action: "cancel" })).toThrow(HttpError);
    expect(() => applyPostAction(d, { action: "cancel" })).toThrow(HttpError);
  });

  it("reschedule: scheduled only", () => {
    const a = make("scheduled"), q = make("queued");
    expect(applyPostAction(a, { action: "reschedule", scheduledAt: "2026-07-01T10:00:00+02:00" }).scheduled_at).toBe("2026-07-01T08:00:00.000Z");
    expect(() => applyPostAction(q, { action: "reschedule", scheduledAt: "2026-07-01T10:00:00Z" })).toThrow(/Only scheduled/);
    expect(() => applyPostAction("missing", { action: "cancel" })).toThrow(/not found/);
  });

  it("delete: not for published / in-flight posts", () => {
    const ok1 = make("failed"), ok2 = make("cancelled"), pub = make("published"), proc = make("processing"), live = make("publishing");
    deletePost(ok1);
    deletePost(ok2);
    for (const id of [pub, proc, live]) expect(() => deletePost(id)).toThrow(/cannot be deleted/);
    expect(all("select id from posts")).toHaveLength(3);
  });
});
