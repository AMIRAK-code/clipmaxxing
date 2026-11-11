import { describe, expect, it } from "vitest";
import { checkSchedule, formatCountdown, localValueIn, tzOffsetMinutes, zonedLocalToUtc } from "./schedule";

const iso = (z: ReturnType<typeof zonedLocalToUtc>) => z?.utc.toISOString();

describe("zonedLocalToUtc", () => {
  it("converts plain wall times", () => {
    expect(iso(zonedLocalToUtc("2026-07-01T12:00", "UTC"))).toBe("2026-07-01T12:00:00.000Z");
    expect(iso(zonedLocalToUtc("2026-07-01T12:00", "Europe/Berlin"))).toBe("2026-07-01T10:00:00.000Z"); // CEST +2
    expect(iso(zonedLocalToUtc("2026-01-15T12:00", "Europe/Berlin"))).toBe("2026-01-15T11:00:00.000Z"); // CET +1
    expect(iso(zonedLocalToUtc("2026-01-15T09:30", "Asia/Kolkata"))).toBe("2026-01-15T04:00:00.000Z"); // +5:30
    expect(iso(zonedLocalToUtc("2026-07-01T08:00", "America/Los_Angeles"))).toBe("2026-07-01T15:00:00.000Z");
  });

  it("handles the spring-forward gap (America/New_York 2026-03-08 02:30 does not exist)", () => {
    const z = zonedLocalToUtc("2026-03-08T02:30", "America/New_York")!;
    expect(z.inGap).toBe(true);
    // shifted forward to 03:30 EDT = 07:30Z
    expect(z.utc.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(zonedLocalToUtc("2026-03-08T03:30", "America/New_York")!.inGap).toBe(false);
  });

  it("picks the first occurrence on fall-back (Europe/Berlin 2026-10-25 02:30 happens twice)", () => {
    const z = zonedLocalToUtc("2026-10-25T02:30", "Europe/Berlin")!;
    expect(z.ambiguous).toBe(true);
    expect(z.utc.toISOString()).toBe("2026-10-25T00:30:00.000Z"); // CEST (+2) first
  });

  it("offset is DST aware", () => {
    expect(tzOffsetMinutes(Date.parse("2026-07-01T00:00:00Z"), "Europe/Berlin")).toBe(120);
    expect(tzOffsetMinutes(Date.parse("2026-12-01T00:00:00Z"), "Europe/Berlin")).toBe(60);
    expect(tzOffsetMinutes(Date.parse("2026-12-01T00:00:00Z"), "America/New_York")).toBe(-300);
  });

  it("rejects malformed and impossible input", () => {
    expect(zonedLocalToUtc("nope", "UTC")).toBeNull();
    expect(zonedLocalToUtc("2026-02-30T10:00", "UTC")).toBeNull();
    expect(zonedLocalToUtc("2026-01-01T25:00", "UTC")).toBeNull();
  });
});

describe("checkSchedule", () => {
  const now = new Date("2026-11-11T10:00:00Z");
  it("accepts a future time and returns UTC", () => {
    const r = checkSchedule("2026-11-12T10:00", "Europe/Berlin", now);
    expect(r.ok).toBe(true);
    expect(r.utc?.toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });
  it("rejects past times, even when only past in that zone", () => {
    expect(checkSchedule("2026-11-11T10:30", "Asia/Tokyo", now).ok).toBe(false); // 01:30Z is before now
    expect(checkSchedule("2026-11-11T09:59", "UTC", now).ok).toBe(false);
    expect(checkSchedule("2026-11-11T10:00", "UTC", now).error).toMatch(/past/);
  });
  it("rejects times less than the minimum lead", () => {
    expect(checkSchedule("2026-11-11T10:00", "UTC", new Date("2026-11-11T09:59:30Z")).ok).toBe(false);
    expect(checkSchedule("2026-11-11T10:02", "UTC", new Date("2026-11-11T09:59:30Z")).ok).toBe(true);
  });
  it("rejects empty, malformed and unknown zones", () => {
    expect(checkSchedule("", "UTC", now).ok).toBe(false);
    expect(checkSchedule("2026-11-12T10:00", "Mars/Base", now).ok).toBe(false);
    expect(checkSchedule("garbage", "UTC", now).ok).toBe(false);
  });
  it("flags a DST gap with a note but still accepts it", () => {
    const r = checkSchedule("2027-03-14T02:30", "America/New_York", new Date("2027-03-01T00:00:00Z"));
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/does not exist/);
  });
});

describe("localValueIn", () => {
  it("renders now+N minutes as a wall-clock value in the zone", () => {
    expect(localValueIn("Asia/Tokyo", new Date("2026-11-11T10:00:00Z"), 5)).toBe("2026-11-11T19:05");
    expect(localValueIn("UTC", new Date("2026-11-11T23:58:00Z"), 5)).toBe("2026-11-12T00:03");
  });
});

describe("formatCountdown", () => {
  it("formats ranges", () => {
    expect(formatCountdown(-5)).toBe("due now");
    expect(formatCountdown(0)).toBe("due now");
    expect(formatCountdown(42_000)).toBe("in 42s");
    expect(formatCountdown(125_000)).toBe("in 2m 05s");
    expect(formatCountdown(3 * 3600_000 + 12 * 60_000)).toBe("in 3h 12m");
    expect(formatCountdown(50 * 3600_000)).toBe("in 2d 2h");
  });
});
