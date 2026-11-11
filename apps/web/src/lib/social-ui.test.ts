import { describe, expect, it } from "vitest";
import { counterTone, effectiveText, formatHashtags, groupBatches, parseHashtags, pruneOverride, summarizeBatch } from "./social-ui";

const shared = { caption: "Hello", hashtags: ["a", "b"], title: "T" };

describe("hashtags", () => {
  it("parses, strips #, de-duplicates case-insensitively", () => {
    expect(parseHashtags("#Foo, bar  #foo\n##baz")).toEqual(["Foo", "bar", "baz"]);
    expect(parseHashtags("")).toEqual([]);
  });
  it("formats with a single #", () => {
    expect(formatHashtags(["a", "#b"])).toBe("#a #b");
  });
});

describe("override merge", () => {
  it("falls back to the shared values", () => {
    expect(effectiveText(shared, undefined)).toEqual(shared);
    expect(effectiveText(shared, { caption: "X" })).toEqual({ ...shared, caption: "X" });
  });
  it("an empty override string still wins (the user cleared it on purpose)", () => {
    expect(effectiveText(shared, { caption: "" }).caption).toBe("");
  });
  it("prunes overrides that equal the shared value", () => {
    expect(pruneOverride(shared, { caption: "Hello", hashtags: ["a", "b"], title: "T" })).toBeUndefined();
    expect(pruneOverride(shared, { caption: "Other", title: "T" })).toEqual({ caption: "Other" });
  });
});

describe("counterTone", () => {
  it("ok / warn at 90% / over", () => {
    expect(counterTone(10, 100)).toBe("ok");
    expect(counterTone(91, 100)).toBe("warn");
    expect(counterTone(100, 100)).toBe("warn");
    expect(counterTone(101, 100)).toBe("over");
  });
});

describe("summarizeBatch", () => {
  it("produces the partial-failure line", () => {
    const s = summarizeBatch([
      { status: "published" },
      { status: "published" },
      { status: "published" },
      { status: "published" },
      { status: "failed" },
      { status: "scheduled" },
    ]);
    expect(s.text).toBe("4 of 6 published · 1 failed · 1 scheduled");
    expect(s.done).toBe(false);
  });
  it("is done when nothing is pending", () => {
    const s = summarizeBatch([{ status: "published" }, { status: "cancelled" }, { status: "failed" }]);
    expect(s.done).toBe(true);
    expect(s.text).toBe("1 of 3 published · 1 failed · 1 cancelled");
  });
  it("counts queued/publishing/processing as in progress", () => {
    const s = summarizeBatch([{ status: "queued" }, { status: "publishing" }, { status: "processing" }]);
    expect(s.active).toBe(3);
    expect(s.text).toBe("0 of 3 published · 3 in progress");
  });
});

describe("groupBatches", () => {
  it("newest batch first, keeps in-batch order", () => {
    const g = groupBatches([
      { batch_id: "old", created_at: "2026-01-01T00:00:00Z", status: "published" as const, n: 1 },
      { batch_id: "new", created_at: "2026-02-01T00:00:00Z", status: "queued" as const, n: 2 },
      { batch_id: "old", created_at: "2026-01-01T00:00:01Z", status: "failed" as const, n: 3 },
    ]);
    expect(g.map((x) => x.batchId)).toEqual(["new", "old"]);
    expect(g[1]!.posts.map((p) => p.n)).toEqual([1, 3]);
  });
});
