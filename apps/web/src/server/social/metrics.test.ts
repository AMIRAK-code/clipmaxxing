import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishError, type Publisher } from "@klipz/publishers";
import type { Provider } from "@klipz/shared";
import { setupTestEnv, cleanup, freshDb, seedClip, addAccount, fakePublisher, type Seed } from "./test-helpers";

const tmp = setupTestEnv("metrics");

import { all, get, newId, run } from "../db";
import { pullMetrics } from "./metrics";
import { analytics } from "./analytics";

afterAll(() => cleanup(tmp));

let seed: Seed;
beforeEach(() => {
  freshDb(tmp);
  seed = seedClip();
});

const D1 = new Date("2026-06-10T08:00:00.000Z");
const day = (n: number, h = 8) => new Date(D1.getTime() + n * 86400_000 + (h - 8) * 3600_000);

function published(provider: Provider, publishedAt: Date, clipId = seed.clipId): { id: string; accountId: string } {
  const acc = addAccount(provider);
  const id = newId();
  run(
    "insert into posts (id, batch_id, clip_id, render_id, social_account_id, provider, status, external_id, external_url, published_at) values (?, 'b', ?, ?, ?, ?, 'published', ?, ?, ?)",
    id,
    clipId,
    seed.renderId,
    acc.id,
    provider,
    `ext-${id}`,
    `https://sandbox.invalid/${provider}/${id}`,
    publishedAt.toISOString(),
  );
  return { id, accountId: acc.id };
}

/** metrics publisher whose views grow by 100 per call */
function growing(provider: Provider): Publisher {
  let n = 0;
  return fakePublisher(provider, { fetchMetrics: async () => ({ views: 100 * ++n, likes: 10 * n, comments: n, shares: 2 * n, saves: 0, impressions: 200 * n, watchTimeSec: 5, raw: { n } }) });
}

describe("pullMetrics", () => {
  it("captures at most once per post per calendar day, then again the next day", async () => {
    const a = published("x", day(0, 7));
    const pub = growing("x");
    const fetch = vi.spyOn(pub, "fetchMetrics");
    const deps = { publisherFor: () => pub };
    let s = await pullMetrics(day(0, 9), deps);
    expect(s).toMatchObject({ considered: 1, captured: 1, skippedToday: 0 });
    s = await pullMetrics(day(0, 20), deps);
    expect(s).toMatchObject({ captured: 0, skippedToday: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    s = await pullMetrics(day(1, 9), deps);
    expect(s.captured).toBe(1);
    const rows = all<{ captured_on: string; views: number }>("select captured_on, views from post_metrics where post_id = ? order by captured_on", a.id);
    expect(rows).toEqual([{ captured_on: "2026-06-10", views: 100 }, { captured_on: "2026-06-11", views: 200 }]);
  });

  it("skips posts older than 90 days and unpublished posts", async () => {
    published("x", day(-91));
    run("insert into posts (id, batch_id, clip_id, provider, status) values ('q', 'b', ?, 'x', 'queued')", seed.clipId);
    const s = await pullMetrics(day(0), { publisherFor: growing });
    expect(s.considered).toBe(0);
  });

  it("records failures and keeps going; needsReconnect flags the account", async () => {
    const bad = published("x", day(0, 7));
    const reconnect = published("linkedin", day(0, 7));
    const good = published("youtube", day(0, 7));
    const pubs: Partial<Record<Provider, Publisher>> = {
      x: fakePublisher("x", { fetchMetrics: async () => { throw new PublishError("503", { code: "server_error", retryable: true }); } }),
      linkedin: fakePublisher("linkedin", { fetchMetrics: async () => { throw new PublishError("revoked", { code: "auth_invalid", needsReconnect: true }); } }),
    };
    const s = await pullMetrics(day(0, 9), { publisherFor: (p) => pubs[p] ?? growing(p) });
    expect(s.captured).toBe(1);
    expect(s.failed.map((f) => f.postId).sort()).toEqual([bad.id, reconnect.id].sort());
    expect(get("select status from social_accounts where id = ?", reconnect.accountId)).toEqual({ status: "needs_reconnect" });
    expect(get("select count(*) as n from post_metrics where post_id = ?", good.id)).toEqual({ n: 1 });
    // failed posts have no row today, so the next pull retries them
    expect(get("select count(*) as n from post_metrics where post_id = ?", bad.id)).toEqual({ n: 0 });
  });
});

describe("analytics", () => {
  it("aggregates the latest snapshot per post: totals, per provider, per clip, daily series", async () => {
    const other = seedClip();
    const p1 = published("youtube", day(-1)); // clip A
    const p2 = published("x", day(-1)); // clip A
    const p3 = published("youtube", day(-1), other.clipId); // clip B
    run("insert into post_metrics (post_id, captured_on, views, likes, comments, shares, saves, impressions) values (?, '2026-06-10', 100, 10, 1, 2, 0, 150), (?, '2026-06-11', 300, 30, 3, 6, 0, 400)", p1.id, p1.id);
    run("insert into post_metrics (post_id, captured_on, views, likes, comments, shares, saves, impressions) values (?, '2026-06-11', 50, 5, 0, 1, 0, 70)", p2.id);
    run("insert into post_metrics (post_id, captured_on, views, likes, comments, shares, saves, impressions) values (?, '2026-06-10', 20, 2, 0, 0, 0, 30)", p3.id);
    run("update clips set title = 'Other clip' where id = ?", other.clipId);

    const a = analytics(30, day(2));
    expect(a.totals).toEqual({ posts: 3, views: 370, likes: 37, comments: 3, shares: 7, saves: 0, impressions: 500 });
    expect(a.byProvider.youtube).toMatchObject({ posts: 2, views: 320 });
    expect(a.byProvider.x).toMatchObject({ posts: 1, views: 50 });
    expect(a.clips.map((c) => c.title)).toEqual(["Clip title", "Other clip"]);
    expect(a.clips[0]).toMatchObject({ clipId: seed.clipId, totals: { views: 350 } });
    expect(a.clips[0]!.providers.youtube).toMatchObject({ views: 300, likes: 30, comments: 3, shares: 6, url: expect.stringContaining("sandbox.invalid") });
    expect(a.clips[0]!.providers.x).toMatchObject({ views: 50 });
    // 06-10: p1=100 + p3=20; 06-11: p1=300 + p2=50 + p3 carried forward 20
    expect(a.series).toEqual([
      expect.objectContaining({ date: "2026-06-10", views: 120, viewsDelta: 120 }),
      expect.objectContaining({ date: "2026-06-11", views: 370, viewsDelta: 250 }),
    ]);
    // per-platform split used by the stacked analytics chart
    expect(a.series[1]!.byProvider).toEqual({ youtube: { views: 320, viewsDelta: 200 }, x: { views: 50, viewsDelta: 50 } });
    expect(a.lastCapturedOn).toBe("2026-06-11");
  });

  it("respects the days window and handles posts without any snapshot", () => {
    published("x", day(-40));
    published("x", day(-1));
    const a = analytics(30, day(0));
    expect(a.totals.posts).toBe(1);
    expect(a.totals.views).toBe(0);
    expect(a.series).toEqual([]);
    expect(analytics(60, day(0)).totals.posts).toBe(2);
  });
});
