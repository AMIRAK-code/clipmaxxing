import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestEnv, cleanup, freshDb, seedClip, addAccount } from "./test-helpers";

const tmp = setupTestEnv("besttimes");

import { newId, run } from "../db";
import { DEFAULT_SLOTS, localParts, nextSlots, rankBuckets, suggestBestTimes, zonedToUtc } from "./best-times";

afterAll(() => cleanup(tmp));
beforeEach(() => freshDb(tmp));

describe("time zone math", () => {
  it("converts local wall time to UTC on both sides of a US DST change", () => {
    const iso = (ms: number | undefined) => new Date(ms!).toISOString();
    // New York: spring forward 2026-03-08 02:00 local
    expect(iso(zonedToUtc(2026, 3, 7, 9, 0, "America/New_York"))).toBe("2026-03-07T14:00:00.000Z"); // EST -5
    expect(iso(zonedToUtc(2026, 3, 9, 9, 0, "America/New_York"))).toBe("2026-03-09T13:00:00.000Z"); // EDT -4
    expect(zonedToUtc(2026, 3, 8, 2, 30, "America/New_York")).toBeUndefined(); // does not exist
    // Berlin: fall back 2026-10-25
    expect(iso(zonedToUtc(2026, 10, 24, 18, 0, "Europe/Berlin"))).toBe("2026-10-24T16:00:00.000Z"); // CEST +2
    expect(iso(zonedToUtc(2026, 10, 26, 18, 0, "Europe/Berlin"))).toBe("2026-10-26T17:00:00.000Z"); // CET +1
    expect(iso(zonedToUtc(2026, 6, 1, 12, 0, "Asia/Kolkata"))).toBe("2026-06-01T06:30:00.000Z");
  });

  it("localParts reports weekday and hour in the zone", () => {
    expect(localParts(new Date("2026-06-01T23:30:00Z"), "Asia/Tokyo")).toMatchObject({ day: 2, hour: 8, weekday: 2 });
    expect(localParts(new Date("2026-06-01T00:30:00Z"), "America/Los_Angeles")).toMatchObject({ day: 31, hour: 17, weekday: 0 });
  });

  it("nextSlots keeps the LOCAL hour across a DST change and skips past times", () => {
    const now = new Date("2026-03-06T12:00:00Z"); // Friday
    const slots = nextSlots(
      [
        { weekday: 6, hour: 9, reason: "r" }, // Sat 7 Mar (EST)
        { weekday: 1, hour: 9, reason: "r" }, // Mon 9 Mar (EDT)
        { weekday: 5, hour: 7, reason: "r" }, // today 07:00 local is past -> next Friday
      ],
      "America/New_York",
      now,
      3,
    );
    expect(slots.map((s) => [s.local, s.at])).toEqual([
      ["2026-03-07 09:00", "2026-03-07T14:00:00.000Z"],
      ["2026-03-09 09:00", "2026-03-09T13:00:00.000Z"],
      ["2026-03-13 07:00", "2026-03-13T11:00:00.000Z"],
    ]);
  });
});

describe("suggestions", () => {
  it("uses documented defaults without history and says so", () => {
    const out = suggestBestTimes(["youtube", "x"], "Europe/Berlin", new Date("2026-06-01T10:00:00Z"));
    for (const p of ["youtube", "x"]) {
      expect(out[p]!.basis).toBe("default");
      expect(out[p]!.slots).toHaveLength(3);
      for (const s of out[p]!.slots) {
        expect(new Date(s.at).getTime()).toBeGreaterThan(new Date("2026-06-01T10:00:00Z").getTime());
        expect(DEFAULT_SLOTS[p as "youtube" | "x"].some(([d, h]) => d === s.weekday && h === s.hour)).toBe(true);
        expect(s.reason).toMatch(/General/);
      }
    }
    const times = out.x!.slots.map((s) => new Date(s.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  function history(provider: "youtube" | "tiktok", n: number, hourUtc: number, views: number, dayOffset = 0) {
    const { clipId } = seedClip();
    const acc = addAccount(provider, `a-${newId()}`);
    for (let i = 0; i < n; i++) {
      const id = newId();
      // 2026-05-04 is a Monday; add whole weeks so every post lands on the same weekday/hour
      const when = new Date(Date.UTC(2026, 4, 4 + dayOffset + 7 * i, hourUtc, 15));
      run("insert into posts (id, batch_id, clip_id, social_account_id, provider, status, external_id, published_at) values (?, 'b', ?, ?, ?, 'published', 'e', ?)", id, clipId, acc.id, provider, when.toISOString());
      run("insert into post_metrics (post_id, captured_on, views) values (?, '2026-06-01', ?)", id, views);
    }
  }

  it("with >= 5 published posts it ranks the user's own hour-of-week buckets by mean views", () => {
    history("youtube", 4, 17, 5000); // Mondays 17:xx UTC: best
    history("youtube", 3, 9, 100, 2); // Wednesdays 09:xx UTC: worst
    const now = new Date("2026-06-01T10:00:00Z"); // Monday
    const out = suggestBestTimes(["youtube"], "UTC", now).youtube!;
    expect(out.basis).toBe("history");
    expect(out.sampleSize).toBe(7);
    expect(out.slots[0]).toMatchObject({ weekday: 1, hour: 17, at: "2026-06-01T17:00:00.000Z" });
    expect(out.slots[0]!.reason).toMatch(/Your posts on Mon around 17:00 averaged 5000 views/);
    expect(out.slots.map((s) => s.at)).toEqual(["2026-06-01T17:00:00.000Z", "2026-06-03T09:00:00.000Z", "2026-06-08T17:00:00.000Z"]);
  });

  it("buckets are computed in the requested time zone", () => {
    const r = rankBuckets([{ publishedAt: "2026-06-01T23:30:00Z", views: 10 }], "Asia/Tokyo");
    expect(r[0]).toMatchObject({ weekday: 2, hour: 8 });
  });

  it("fewer than 5 published posts falls back to defaults; other providers are unaffected", () => {
    history("tiktok", 4, 12, 999);
    const out = suggestBestTimes(["tiktok"], "UTC", new Date("2026-06-01T10:00:00Z")).tiktok!;
    expect(out.basis).toBe("default");
    expect(out.sampleSize).toBe(4);
  });
});
