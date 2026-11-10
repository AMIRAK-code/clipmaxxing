import { describe, expect, it } from "vitest";
import {
  CAPTION_PRESETS,
  SAFE_ZONES,
  activeWordIndex,
  captionWordsOnTimeline,
  clampToSafeZone,
  createDefaultEditState,
  duckGainAt,
  editWordText,
  heuristicEmphasis,
  interpolateKeys,
  layoutAt,
  layoutLines,
  outToSrc,
  pageAt,
  paginate,
  paneVideoStyle,
  rippleDelete,
  rippleDeleteRange,
  splitAt,
  srcToOut,
  totalDuration,
  trimPiece,
  windowAround,
  zoomAt,
  type CaptionWord,
  type CropTrack,
  type VideoPiece,
  type Word,
} from "./index";

const pieces: VideoPiece[] = [
  { id: "a", srcStart: 10, srcEnd: 20 },
  { id: "b", srcStart: 30, srcEnd: 35 },
];

describe("timeline", () => {
  it("maps between source and output time across cuts", () => {
    expect(totalDuration(pieces)).toBe(15);
    expect(srcToOut(pieces, 12)).toBe(2);
    expect(srcToOut(pieces, 31)).toBe(11);
    expect(srcToOut(pieces, 25)).toBeNull();
    expect(outToSrc(pieces, 11)).toEqual({ index: 1, tSrc: 31 });
    expect(outToSrc(pieces, 99)).toEqual({ index: 1, tSrc: 35 });
  });

  it("splits, ripple-deletes and trims", () => {
    const s = splitAt(pieces, 4);
    expect(s.map((p) => [p.srcStart, p.srcEnd])).toEqual([
      [10, 14],
      [14, 20],
      [30, 35],
    ]);
    expect(totalDuration(s)).toBe(15);
    expect(splitAt(pieces, 0)).toBe(pieces); // edge: no-op
    const d = rippleDelete(s, s[1]!.id);
    expect(totalDuration(d)).toBe(9);
    expect(srcToOut(d, 30)).toBe(4); // gap closed
    expect(rippleDelete([pieces[0]!], "a")).toHaveLength(1); // never delete the last piece
    const r = rippleDeleteRange(pieces, 8, 12);
    expect(r.map((p) => [p.srcStart, p.srcEnd])).toEqual([
      [10, 18],
      [32, 35],
    ]);
    const t = trimPiece(pieces, "a", "start", 5, { min: 8, max: 40 });
    expect(t[0]!.srcStart).toBe(8);
    expect(trimPiece(pieces, "a", "end", 0, { min: 8, max: 40 })[0]!.srcEnd).toBeCloseTo(10.1);
  });

  it("re-times caption words and drops the ones that were cut", () => {
    const words: CaptionWord[] = [
      { id: "1", w: "kept", s: 11, e: 11.5 },
      { id: "2", w: "cut", s: 22, e: 22.4 },
      { id: "3", w: "later", s: 30.5, e: 31 },
      { id: "4", w: "hidden", s: 12, e: 12.2, hidden: true },
    ];
    const out = captionWordsOnTimeline(pieces, words);
    expect(out.map((w) => [w.w, w.os, w.oe])).toEqual([
      ["kept", 1, 1.5],
      ["later", 10.5, 11],
    ]);
  });

  it("ducks main audio under b-roll with a ramp and interpolates zoom", () => {
    const edit = {
      volume: 1,
      duckLevel: 0.25,
      audio: [],
      broll: [
        { id: "b", src: "x", kind: "video" as const, start: 5, duration: 2, srcOffset: 0, volume: 1, duck: true, fit: "cover" as const },
      ],
    };
    expect(duckGainAt(edit, 1)).toBe(1);
    expect(duckGainAt(edit, 6)).toBeCloseTo(0.25);
    expect(duckGainAt(edit, 4.875)).toBeCloseTo(0.625);
    const zooms = [
      { id: "1", t: 0, scale: 1, ease: "linear" as const },
      { id: "2", t: 2, scale: 1.4, ease: "linear" as const },
    ];
    expect(zoomAt(zooms, 1)).toBeCloseTo(1.2);
    expect(zoomAt(zooms, 9)).toBe(1.4);
    expect(zoomAt([], 3)).toBe(1);
  });
});

describe("captions", () => {
  const mk = (list: Array<[string, number, number]>) => list.map(([w, s, e], i) => ({ id: String(i), w, s, e, os: s, oe: e }));

  it("paginates 1-4 words, breaking on sentence ends and pauses", () => {
    const words = mk([
      ["This", 0, 0.2],
      ["is", 0.2, 0.4],
      ["great.", 0.4, 0.8],
      ["Now", 0.9, 1.1],
      ["wait", 3, 3.3],
      ["for", 3.3, 3.5],
      ["it", 3.5, 3.7],
      ["ok", 3.7, 3.9],
    ]);
    const pages = paginate(words, { wordsPerPage: 3, maxCharsPerLine: 16 });
    expect(pages.map((p) => p.words.map((w) => w.w).join(" "))).toEqual(["This is great.", "Now", "wait for it", "ok"]);
    for (const p of pages) expect(p.words.length).toBeLessThanOrEqual(3);
    expect(pageAt(pages, 0.3)).toBe(pages[0]);
    expect(pageAt(pages, 2.5)).toBeNull(); // long pause shows nothing
    expect(activeWordIndex(pages[0]!, 0.25)).toBe(1);
    expect(activeWordIndex(pages[2]!, 2.99)).toBe(-1);
  });

  it("lays out lines within the character budget", () => {
    const lines = layoutLines([{ w: "absolutely" }, { w: "incredible" }, { w: "stuff" }], 12);
    expect(lines.map((l) => l.map((w) => w.w).join(" "))).toEqual(["absolutely", "incredible", "stuff"]);
  });

  it("edits word text without touching timing", () => {
    const words: CaptionWord[] = [
      { id: "a", w: "teh", s: 1, e: 2 },
      { id: "b", w: "end", s: 2, e: 3 },
    ];
    expect(editWordText(words, "a", "the")).toEqual([{ id: "a", w: "the", s: 1, e: 2 }, words[1]]);
    const split = editWordText(words, "a", "of the");
    expect(split.map((w) => [w.w, w.s, w.e])).toEqual([
      ["of", 1, 1.5],
      ["the", 1.5, 2],
      ["end", 2, 3],
    ]);
    expect(editWordText(words, "a", "  ")[0]!.hidden).toBe(true);
  });

  it("picks emphasis words offline", () => {
    const words = "I made 50000 dollars in the first week honestly".split(" ").map((w) => ({ w }));
    const picks = heuristicEmphasis(words, 0.25);
    expect(picks.has(2)).toBe(true);
    expect(picks.has(0)).toBe(false);
  });

  it("ships 8 unique presets with valid page sizes", () => {
    expect(CAPTION_PRESETS).toHaveLength(8);
    expect(new Set(CAPTION_PRESETS.map((p) => p.id)).size).toBe(8);
    for (const p of CAPTION_PRESETS) expect([1, 2, 3, 4]).toContain(p.wordsPerPage);
  });

  it("keeps captions out of platform UI", () => {
    expect(clampToSafeZone(0.95, SAFE_ZONES.tiktok)).toBeCloseTo(0.69);
    expect(clampToSafeZone(0.5, SAFE_ZONES.tiktok)).toBe(0.5);
    expect(clampToSafeZone(0.95, null)).toBe(0.95);
  });
});

describe("crop", () => {
  const track: CropTrack = {
    version: 1,
    srcW: 1920,
    srcH: 1080,
    segments: [
      {
        start: 0,
        end: 5,
        layout: "crop",
        keys: [
          { t: 0, cx: 0.2, cy: 0.5 },
          { t: 4, cx: 0.6, cy: 0.5 },
        ],
      },
      { start: 5, end: 10, layout: "crop", keys: [{ t: 5, cx: 0.9, cy: 0.5 }] },
      { start: 10, end: 12, layout: "split", keys: [{ t: 10, cx: 0.25, cy: 0.4 }], keys2: [{ t: 10, cx: 0.75, cy: 0.4 }] },
      { start: 12, end: 14, layout: "letterbox", keys: [] },
    ],
  };

  it("interpolates inside a shot and hard-cuts between shots", () => {
    expect(interpolateKeys(track.segments[0]!.keys, 2).cx).toBeCloseTo(0.4);
    const before = layoutAt(track, 4.99, 1080, 1920, 1920, 1080).panes[0]!.src.x;
    const after = layoutAt(track, 5.0, 1080, 1920, 1920, 1080).panes[0]!.src.x;
    expect(after - before).toBeGreaterThan(400); // jump, not a pan
  });

  it("keeps the 9:16 window inside the frame", () => {
    const r = windowAround(1920, 1080, 9 / 16, 0.99, 0.5);
    expect(r.w).toBeCloseTo(607.5);
    expect(r.x + r.w).toBeCloseTo(1920);
    const style = paneVideoStyle({ dst: { x: 0, y: 0, w: 1080, h: 1920 }, src: r }, 1920, 1080);
    expect(style.height).toBeCloseTo(1920);
    expect(style.left).toBeCloseTo(-(1920 - 607.5) * (1080 / 607.5));
  });

  it("builds split and letterbox layouts and falls back to centre", () => {
    const split = layoutAt(track, 11, 1080, 1920, 1920, 1080);
    expect(split.panes).toHaveLength(2);
    expect(split.panes[1]!.dst).toEqual({ x: 0, y: 960, w: 1080, h: 960 });
    const lb = layoutAt(track, 13, 1080, 1920, 1920, 1080);
    expect(lb.blurredBackground).toBe(true);
    expect(lb.panes[0]!.dst.h).toBeCloseTo(607.5);
    const none = layoutAt(null, 1, 1080, 1920, 1920, 1080);
    expect(none.panes[0]!.src.x).toBeCloseTo((1920 - 607.5) / 2);
  });
});

describe("default edit state", () => {
  it("covers the clip range with captions from the transcript", () => {
    const words: Word[] = [
      { w: "before", s: 1, e: 2 },
      { w: " Hello", s: 10, e: 10.4 },
      { w: "world", s: 10.4, e: 11 },
      { w: "after", s: 40, e: 41 },
    ];
    const edit = createDefaultEditState({ start: 10, end: 20, words, hook: "Wait for it" });
    expect(edit.video).toHaveLength(1);
    expect(edit.captions.words.map((w) => w.w)).toEqual(["Hello", "world"]);
    expect(edit.hook.text).toBe("Wait for it");
  });
});
