import { captionWordsOnTimeline, srcToOut, totalDuration } from "@klipz/shared";
import { describe, expect, it } from "vitest";
import { sampleEdit } from "./fixtures";
import * as ops from "./ops";
import { createEditorStore } from "./store";

function setup() {
  let t = 0;
  const store = createEditorStore(sampleEdit(), () => (t += 10_000)); // every change is its own undo step
  return { store, get: () => store.getState() };
}

describe("editor store: video track", () => {
  it("splits at the playhead and undoes", () => {
    const { get } = setup();
    get().splitAt(4);
    expect(get().edit.video).toHaveLength(2);
    expect(get().edit.video[0]!.srcEnd).toBeCloseTo(24);
    expect(get().edit.video[1]!.srcStart).toBeCloseTo(24);
    get().undo();
    expect(get().edit.video).toHaveLength(1);
    get().redo();
    expect(get().edit.video).toHaveLength(2);
  });

  it("split is a no-op at a piece edge (nothing recorded)", () => {
    const { get } = setup();
    get().splitAt(0);
    expect(get().canUndo).toBe(false);
  });

  it("ripple delete shortens the output, drops the cut captions, and undo restores both", () => {
    const { get } = setup();
    get().splitAt(3);
    get().splitAt(6);
    const mid = get().edit.video[1]!;
    const before = captionWordsOnTimeline(get().edit.video, get().edit.captions.words).length;
    get().rippleDeletePiece(mid.id);
    expect(totalDuration(get().edit.video)).toBeCloseTo(7);
    const after = captionWordsOnTimeline(get().edit.video, get().edit.captions.words);
    expect(after.length).toBe(before - 6);
    // words from the removed range 23..26 are gone from the timeline
    expect(after.every((w) => w.s < 23 || w.s >= 26)).toBe(true);
    get().undo();
    expect(totalDuration(get().edit.video)).toBeCloseTo(10);
    expect(captionWordsOnTimeline(get().edit.video, get().edit.captions.words)).toHaveLength(before);
  });

  it("refuses to delete the only piece", () => {
    const { get } = setup();
    get().select({ kind: "piece", id: get().edit.video[0]!.id });
    expect(get().deleteSelection()).toBe(false);
    expect(get().edit.video).toHaveLength(1);
  });

  it("deleteSelection ripple-deletes the selected piece and clears the selection", () => {
    const { get } = setup();
    get().splitAt(5);
    const first = get().edit.video[0]!;
    get().select({ kind: "piece", id: first.id });
    expect(get().deleteSelection()).toBe(true);
    expect(get().edit.video).toHaveLength(1);
    expect(get().selection).toBeNull();
  });

  it("trims a piece edge within bounds (clip range ± 5 s handles) and coalesces the drag", () => {
    const { store, get } = setup();
    const bounds = ops.trimBounds({ start_sec: 20, end_sec: 30 }, 45);
    expect(bounds).toEqual({ min: 15, max: 35 });
    const id = get().edit.video[0]!.id;
    for (let s = 30.5; s <= 33; s += 0.5) get().trimPiece(id, "end", s, bounds);
    expect(get().edit.video[0]!.srcEnd).toBe(33);
    get().trimPiece(id, "end", 99, bounds);
    expect(get().edit.video[0]!.srcEnd).toBe(35); // clamped to handle room
    get().trimPiece(id, "start", 0, bounds);
    expect(get().edit.video[0]!.srcStart).toBe(15);
    void store;
  });

  it("trim bounds never exceed the source", () => {
    expect(ops.trimBounds({ start_sec: 2, end_sec: 44 }, 45)).toEqual({ min: 0, max: 45 });
  });

  it("sets and clears a per-piece transition", () => {
    const { get } = setup();
    get().splitAt(5);
    const id = get().edit.video[1]!.id;
    get().apply(ops.setTransition(id, "fade", 0.6));
    expect(get().edit.video[1]!.transitionIn).toEqual({ type: "fade", durationSec: 0.6 });
    get().apply(ops.setTransition(id, "none"));
    expect(get().edit.video[1]!.transitionIn).toBeUndefined();
  });

  it("ripple delete drops zoom keys that fell past the new end", () => {
    const { get } = setup();
    get().splitAt(5);
    get().addZoom(9);
    get().addZoom(1);
    get().rippleDeletePiece(get().edit.video[1]!.id);
    expect(get().edit.zooms.map((z) => z.t)).toEqual([1]);
  });

  it("ripple delete shifts later timeline items left, drops zoom keys inside the cut", () => {
    const { get } = setup();
    get().splitAt(4);
    get().splitAt(7); // pieces: 0-4, 4-7, 7-end
    const mid = get().edit.video[1]!;
    const z1 = get().addZoom(2);
    const z2 = get().addZoom(5.5);
    const z3 = get().addZoom(8);
    const t = get().addText({ start: 9 });
    const b = get().addBroll({ src: "assets/x.png", kind: "image", start: 5, duration: 1 });
    get().rippleDeletePiece(mid.id);
    const zt = (id: string) => get().edit.zooms.find((z) => z.id === id)!.t;
    expect(zt(z1)).toBe(2);
    expect(get().edit.zooms.some((z) => z.id === z2)).toBe(false); // inside the removed footage
    expect(zt(z3)).toBe(5); // 8 - 3
    expect(get().edit.texts.find((x) => x.id === t)!.start).toBe(6);
    expect(get().edit.broll.find((x) => x.id === b)!.start).toBe(4);
    get().undo();
    expect(zt(z3)).toBe(8);
    expect(get().edit.texts.find((x) => x.id === t)!.start).toBe(9);
  });

  it("trimming never crosses a neighbouring piece's source range", () => {
    const { get } = setup();
    get().splitAt(4);
    const [a, b] = get().edit.video;
    const bounds = { min: 0, max: 45 };
    get().trimPiece(a!.id, "end", 30, bounds);
    expect(get().edit.video[0]!.srcEnd).toBe(b!.srcStart);
    get().trimPiece(b!.id, "start", 10, bounds);
    expect(get().edit.video[1]!.srcStart).toBe(a!.srcEnd);
  });
});

describe("editor store: zoom keyframes, look, overlays", () => {
  it("adds, moves, rescales and removes zoom keyframes (sorted by time)", () => {
    const { get } = setup();
    const a = get().addZoom(5, 1.5);
    const b = get().addZoom(2);
    expect(get().edit.zooms.map((z) => z.id)).toEqual([b, a]);
    get().apply(ops.updateZoomKey(a, { t: 1 }));
    expect(get().edit.zooms.map((z) => z.id)).toEqual([a, b]);
    get().apply(ops.updateZoomKey(a, { scale: 9, ease: "snap" }));
    expect(get().edit.zooms[0]).toMatchObject({ scale: 3, ease: "snap" });
    get().select({ kind: "zoom", id: a });
    get().deleteSelection();
    expect(get().edit.zooms.map((z) => z.id)).toEqual([b]);
    get().undo();
    expect(get().edit.zooms).toHaveLength(2);
  });

  it("sets look, hook, progress bar, safe zone, volume", () => {
    const { get } = setup();
    get().apply(ops.setLook("cinematic"));
    get().apply(ops.setHook({ enabled: true, text: "Wait for it", durationSec: 99 }));
    get().apply(ops.setProgressBar({ enabled: true, position: "top", color: "#ff0000", height: 14 }));
    get().apply(ops.setSafeZone("instagram"));
    get().apply(ops.setVolume(5));
    const e = get().edit;
    expect(e.look).toBe("cinematic");
    expect(e.hook).toEqual({ enabled: true, text: "Wait for it", durationSec: 10 });
    expect(e.progressBar).toMatchObject({ enabled: true, position: "top", color: "#ff0000", height: 14 });
    expect(e.safeZone).toBe("instagram");
    expect(e.volume).toBe(2);
    for (let i = 0; i < 5; i++) get().undo();
    expect(get().edit.look).toBe("none");
    expect(get().edit.hook.enabled).toBe(false);
  });
});

describe("editor store: captions", () => {
  it("edits a word's text without touching its timing", () => {
    const { get } = setup();
    const w = get().edit.captions.words[3]!;
    get().apply(ops.editWord(w.id, "HELLO"));
    const n = get().edit.captions.words[3]!;
    expect(n).toMatchObject({ id: w.id, w: "HELLO", s: w.s, e: w.e });
    get().undo();
    expect(get().edit.captions.words[3]!.w).toBe(w.w);
  });

  it("typing several words splits the slot evenly; clearing hides", () => {
    const { get } = setup();
    const w = get().edit.captions.words[0]!;
    const n = get().edit.captions.words.length;
    get().apply(ops.editWord(w.id, "two words"));
    expect(get().edit.captions.words).toHaveLength(n + 1);
    expect(get().edit.captions.words[0]!.e).toBeCloseTo(get().edit.captions.words[1]!.s);
    get().apply(ops.editWord(w.id, "  "));
    expect(get().edit.captions.words.find((x) => x.id === w.id)!.hidden).toBe(true);
  });

  it("toggles emphasis, hidden, emoji", () => {
    const { get } = setup();
    const id = get().edit.captions.words[2]!.id;
    get().apply(ops.toggleWordEmphasis(id));
    expect(get().edit.captions.words[2]!.emph).toBe(true);
    get().apply(ops.toggleWordEmphasis(id));
    expect(get().edit.captions.words[2]!.emph).toBeUndefined();
    get().apply(ops.toggleWordHidden(id));
    expect(captionWordsOnTimeline(get().edit.video, get().edit.captions.words).some((w) => w.id === id)).toBe(false);
    get().apply(ops.setWordEmoji(id, " 🔥 "));
    expect(get().edit.captions.words[2]!.emoji).toBe("🔥");
    get().apply(ops.setWordEmoji(id, ""));
    expect(get().edit.captions.words[2]!.emoji).toBeUndefined();
  });

  it("auto-emphasise marks keywords and replaces earlier flags", () => {
    const { get } = setup();
    get().apply((d) => {
      d.captions.words[0]!.w = "million";
      d.captions.words[1]!.w = "42";
      d.captions.words[2]!.emph = true;
    });
    get().apply(ops.autoEmphasise());
    const w = get().edit.captions.words;
    expect(w[0]!.emph).toBe(true);
    expect(w[1]!.emph).toBe(true);
    expect(w[2]!.emph).toBeUndefined();
  });

  it("style switch clears overrides unless asked to keep them; overrides coalesce", () => {
    let t = 0;
    const store = createEditorStore(sampleEdit(), () => (t += 10));
    const g = store.getState;
    for (const size of [90, 95, 100, 110]) g().apply(ops.setCaptionOverride("fontSize", size), "cap:fontSize");
    expect(g().history.past).toHaveLength(1);
    expect(g().edit.captions.overrides.fontSize).toBe(110);
    g().apply(ops.setCaptionStyle("minimal"));
    expect(g().edit.captions.styleId).toBe("minimal");
    expect(g().edit.captions.overrides).toEqual({});
    g().undo();
    expect(g().edit.captions.overrides.fontSize).toBe(110);
    g().apply(ops.setCaptionOverride("fontSize", undefined));
    expect(g().edit.captions.overrides.fontSize).toBeUndefined();
    g().apply(ops.setCaptionsEnabled(false));
    expect(g().edit.captions.enabled).toBe(false);
  });
});

describe("editor store: b-roll, audio, text", () => {
  it("adds b-roll (ducking on by default), updates and removes it", () => {
    const { get } = setup();
    const id = get().addBroll({ src: "assets/a.mp4", kind: "video", start: 2, duration: 3 });
    expect(get().edit.broll[0]).toMatchObject({ id, start: 2, duration: 3, duck: true, fit: "cover", volume: 1 });
    expect(get().selection).toEqual({ kind: "broll", id });
    get().apply(ops.updateBroll(id, { start: -5, duration: 0, fit: "pip", volume: 9 }));
    expect(get().edit.broll[0]).toMatchObject({ start: 0, duration: ops.MIN_ITEM_SEC, fit: "pip", volume: 2 });
    get().deleteSelection();
    expect(get().edit.broll).toHaveLength(0);
    get().undo();
    expect(get().edit.broll).toHaveLength(1);
  });

  it("adds music and voiceover with the right ducking defaults", () => {
    const { get } = setup();
    const m = get().addAudio({ src: "assets/m.mp3", start: 0, duration: 10 });
    const v = get().addAudio({ src: "assets/v.wav", kind: "voiceover", start: 1, duration: 4 });
    const [music, voice] = [get().edit.audio.find((a) => a.id === m)!, get().edit.audio.find((a) => a.id === v)!];
    expect(music).toMatchObject({ kind: "music", duck: false });
    expect(voice).toMatchObject({ kind: "voiceover", duck: true, volume: 1 });
    get().apply(ops.updateAudio(m, { start: 2, volume: 0.2, duck: true }));
    expect(get().edit.audio.find((a) => a.id === m)).toMatchObject({ start: 2, volume: 0.2, duck: true });
    get().apply(ops.removeAudio(m));
    expect(get().edit.audio.map((a) => a.id)).toEqual([v]);
  });

  it("adds text, clamps normalised position, edits and removes it", () => {
    const { get } = setup();
    const id = get().addText({ start: 1 });
    expect(get().edit.texts[0]).toMatchObject({ id, text: "Your text", start: 1, duration: 3, x: 0.5 });
    get().apply(ops.updateText(id, { x: 4, y: -1, text: "Hi", color: "#00ff00", anim: "fade" }));
    expect(get().edit.texts[0]).toMatchObject({ x: 1, y: 0, text: "Hi", color: "#00ff00", anim: "fade" });
    get().select({ kind: "text", id });
    get().deleteSelection();
    expect(get().edit.texts).toHaveLength(0);
  });
});

describe("editor store: history", () => {
  it("undo drops a selection whose target disappeared", () => {
    const { get } = setup();
    const id = get().addText({ start: 0 });
    expect(get().selection?.id).toBe(id);
    get().undo();
    expect(get().selection).toBeNull();
  });

  it("reset replaces the edit and forgets history; rev always moves forward", () => {
    const { get } = setup();
    const r0 = get().rev;
    get().splitAt(5);
    expect(get().rev).toBeGreaterThan(r0);
    const fresh = sampleEdit(0, 5);
    get().reset(fresh);
    expect(get().edit).toBe(fresh);
    expect(get().canUndo).toBe(false);
    expect(get().canRedo).toBe(false);
  });

  it("srcToOut stays consistent after edits", () => {
    const { get } = setup();
    get().splitAt(5);
    get().rippleDeletePiece(get().edit.video[0]!.id);
    expect(srcToOut(get().edit.video, 22)).toBeNull();
    expect(srcToOut(get().edit.video, 26)).toBeCloseTo(1);
  });
});
