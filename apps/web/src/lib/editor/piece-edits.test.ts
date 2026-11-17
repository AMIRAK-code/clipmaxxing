import { describe, expect, it } from "vitest";
import {
  layoutAt,
  pieceCropTrack,
  pieceLook,
  pieceVolume,
  rippleDeleteRange,
  splitAt,
  type CropTrack,
  type EditState,
  type ManualFrame,
  type VideoPiece,
} from "@klipz/shared";
import { produce } from "immer";
import * as ops from "./ops";

const AUTO: CropTrack = { version: 1, srcW: 1920, srcH: 1080, segments: [{ start: 0, end: 99, layout: "letterbox", keys: [] }] };
const CLOSE: ManualFrame = { layout: "crop", cx: 0.25, cy: 0.5, zoom: 2 };

function edit(video: VideoPiece[], extra: Partial<EditState> = {}): EditState {
  return { version: 1, video, look: "none", volume: 1, duckLevel: 0.3, broll: [], audio: [], texts: [], zooms: [], ...extra } as unknown as EditState;
}

describe("each piece of a split clip can have its own crop, look and volume", () => {
  it("a piece's frame wins over the clip's, which wins over the automatic track", () => {
    const piece: VideoPiece = { id: "a", srcStart: 0, srcEnd: 5 };
    expect(pieceCropTrack({}, piece, AUTO, 1920, 1080)).toBe(AUTO);
    const clipWide = pieceCropTrack({ frame: { layout: "crop", cx: 0.5, cy: 0.5, zoom: 1 } }, piece, AUTO, 1920, 1080)!;
    expect(clipWide.segments[0]).toMatchObject({ layout: "crop", zoom: 1 });
    const own = pieceCropTrack({ frame: { layout: "crop", cx: 0.5, cy: 0.5, zoom: 1 } }, { ...piece, frame: CLOSE }, AUTO, 1920, 1080)!;
    expect(own.segments[0]).toMatchObject({ layout: "crop", zoom: 2, keys: [{ t: 0, cx: 0.25, cy: 0.5 }] });
    // and it is what gets drawn: half the window of zoom 1, centred on a quarter of the width
    const pane = layoutAt(own, 3, 1080, 1920, 1920, 1080).panes[0]!.src;
    expect(pane).toEqual({ x: 0.25 * 1920 - 303.75 / 2, y: 270, w: 303.75, h: 540 });
  });

  it("look and volume fall back to the clip's", () => {
    const e = edit([], { look: "warm", volume: 0.8 });
    expect(pieceLook(e, { look: undefined })).toBe("warm");
    expect(pieceLook(e, { look: "bw" })).toBe("bw");
    expect(pieceLook(e, { look: "none" })).toBe("none"); // "none" is a choice, not "unset"
    expect(pieceVolume(e, {})).toBe(0.8);
    expect(pieceVolume(e, { volume: 0 })).toBe(0);
    expect(pieceVolume(e, { volume: 9 })).toBe(1.5);
    expect(pieceVolume(e, { volume: Number.NaN })).toBe(0.8);
  });

  it("splitting copies the piece's settings to the new half, so nothing changes until one is edited", () => {
    const before: VideoPiece[] = [{ id: "a", srcStart: 0, srcEnd: 10, frame: CLOSE, look: "bw", volume: 0.5, transitionIn: { type: "fade", durationSec: 0.4 } }];
    const [left, right] = splitAt(before, 4);
    expect(left).toMatchObject({ id: "a", srcStart: 0, srcEnd: 4, frame: CLOSE, look: "bw", volume: 0.5, transitionIn: { type: "fade" } });
    expect(right).toMatchObject({ srcStart: 4, srcEnd: 10, frame: CLOSE, look: "bw", volume: 0.5 });
    expect(right!.id).not.toBe("a");
    expect(right!.transitionIn).toBeUndefined();
    expect(right!.frame).not.toBe(left!.frame); // a copy: editing one half must not move the other
    // a plain piece stays plain
    expect(Object.keys(splitAt([{ id: "p", srcStart: 0, srcEnd: 10 }], 4)[1]!).sort()).toEqual(["id", "srcEnd", "srcStart"]);
  });

  it("removing a range keeps the settings of what is left", () => {
    const out = rippleDeleteRange([{ id: "a", srcStart: 0, srcEnd: 10, frame: CLOSE, volume: 0.5, transitionIn: { type: "fade", durationSec: 0.4 } }], 3, 6);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "a", srcEnd: 3, frame: CLOSE, volume: 0.5, transitionIn: { type: "fade" } });
    expect(out[1]).toMatchObject({ srcStart: 6, srcEnd: 10, frame: CLOSE, volume: 0.5 });
    expect(out[1]!.transitionIn).toBeUndefined();
  });

  it("editor ops change one piece and leave the others and the clip alone", () => {
    const base = edit([{ id: "a", srcStart: 0, srcEnd: 4 }, { id: "b", srcStart: 4, srcEnd: 10 }], { frame: { layout: "crop", cx: 0.7, cy: 0.5, zoom: 1.2 } });
    // the first change starts from what the piece shows now: the clip's manual frame
    const zoomed = produce(base, ops.patchPieceFrame("b", { zoom: 3 }));
    expect(zoomed.video[1]!.frame).toEqual({ layout: "crop", cx: 0.7, cy: 0.5, zoom: 3 });
    expect(zoomed.video[0]!.frame).toBeUndefined();
    expect(zoomed.frame).toEqual(base.frame);
    const moved = produce(zoomed, ops.patchPieceFrame("b", { cx: -4, zoom: 99 }));
    expect(moved.video[1]!.frame).toEqual({ layout: "crop", cx: 0, cy: 0.5, zoom: 4 });
    const fit = produce(moved, ops.patchPieceFrame("a", { layout: "letterbox" }));
    expect(fit.video[0]!.frame!.layout).toBe("letterbox");
    expect("frame" in produce(fit, ops.setPieceFrame("b", null)).video[1]!).toBe(false);

    const styled = produce(produce(base, ops.setPieceLook("a", "bw")), ops.setPieceVolume("a", 7));
    expect(styled.video[0]).toMatchObject({ look: "bw", volume: 1.5 });
    expect(styled.video[1]).toEqual(base.video[1]);
    const reset = produce(produce(styled, ops.setPieceLook("a", null)), ops.setPieceVolume("a", null));
    expect(reset.video[0]).toEqual(base.video[0]);
    // an unknown id changes nothing
    expect(produce(base, ops.patchPieceFrame("zzz", { zoom: 2 }))).toBe(base);
  });
});
