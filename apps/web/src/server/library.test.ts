import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLIPS_DIR, RAW_DIR, planLibrary, safeName } from "./library";

const raw = (id: string, filename: string | null, key = `sources/${id}/source.mp4`) => ({
  id, storage_key: key, filename, size_bytes: 10, duration_sec: 5, origin: "youtube" as const, created_at: "2026-01-01T00:00:00Z", project_title: "P",
});
const clip = (render_id: string, clip_title: string | null, project_title: string | null) => ({
  render_id, clip_id: `c-${render_id}`, storage_key: `renders/${render_id}/clip.mp4`, cover_key: `renders/${render_id}/cover.jpg`,
  size_bytes: 20, duration_sec: 30, completed_at: "2026-01-02T00:00:00Z", created_at: "2026-01-02T00:00:00Z", clip_title, project_title,
});

describe("safeName", () => {
  it("strips characters Windows rejects and trailing dots/spaces", () => {
    expect(safeName(String.raw`Why? "This" works: a/b\c <1>|2*. `, "x")).toBe("Why This works a b c 1 2");
    expect(safeName("...", "Video")).toBe("Video");
    expect(safeName("CON", "Video")).toBe("Video");
    expect(safeName("a".repeat(300), "x").length).toBeLessThanOrEqual(110);
  });
});

describe("planLibrary", () => {
  it("names raw videos by title and clips by project/title", () => {
    const plan = planLibrary([raw("aaaaaaaa", "My Talk.mp4"), raw("bbbbbbbb", null, "sources/bbbbbbbb/source.webm")], [clip("r1", "Best moment", "Podcast #1")]);
    expect(plan.map((w) => w.rel)).toEqual([
      path.join(RAW_DIR, "My Talk.mp4"),
      path.join(RAW_DIR, "Video.webm"),
      path.join(CLIPS_DIR, "Podcast #1", "Best moment.mp4"),
    ]);
    expect(plan[0]!.item).toMatchObject({ kind: "raw", title: "My Talk", thumbKey: "sources/aaaaaaaa/thumb.jpg" });
    expect(plan[2]!.item).toMatchObject({ kind: "clip", clipId: "c-r1", thumbKey: "renders/r1/cover.jpg" });
  });

  it("keeps names unique, case-insensitively", () => {
    const plan = planLibrary([raw("11111111", "Same"), raw("22222222", "same")], [clip("abcdef99", "Clip", "P"), clip("fedcba11", "Clip", "P")]);
    const rels = plan.map((w) => w.rel);
    expect(new Set(rels.map((r) => r.toLowerCase())).size).toBe(4);
    expect(rels[1]).toBe(path.join(RAW_DIR, "same [222222].mp4"));
    expect(rels[3]).toBe(path.join(CLIPS_DIR, "P", "Clip [fedcba].mp4"));
  });
});
