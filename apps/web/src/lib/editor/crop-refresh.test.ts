import { describe, expect, it } from "vitest";
import { cropTrackFromClipResponse, isFinishedReframeFor } from "./crop-refresh";

describe("crop refresh", () => {
  it("only a succeeded reframe job for this clip triggers a refresh", () => {
    const job = { type: "reframe", status: "succeeded", payload: { clip_id: "c1" } } as const;
    expect(isFinishedReframeFor(job as never, "c1")).toBe(true);
    expect(isFinishedReframeFor(job as never, "c2")).toBe(false);
    expect(isFinishedReframeFor({ ...job, status: "running" } as never, "c1")).toBe(false);
    expect(isFinishedReframeFor({ ...job, status: "failed" } as never, "c1")).toBe(false);
    expect(isFinishedReframeFor({ ...job, type: "render" } as never, "c1")).toBe(false);
  });
  it("reads only the crop track from the clip response (never the edit)", () => {
    const track = { segments: [] };
    expect(cropTrackFromClipResponse({ clip: { crop_track: track, edit_state: { version: 1 } } })).toBe(track);
    expect(cropTrackFromClipResponse({ clip: { crop_track: null } })).toBeNull();
    expect(cropTrackFromClipResponse({})).toBeUndefined();
    expect(cropTrackFromClipResponse(null)).toBeUndefined();
  });
});
