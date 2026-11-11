import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_FILES, createDefaultEditState, type VideoPiece } from "@klipz/shared";
import { entrance, hookEnvelope, transitionStyle } from "./anim";
import { fitLines, fitScale, measureText } from "./fit";
import { clipDurationInFrames, normalizeProps, resolveSrc } from "./props";
import { pieceFrames } from "./MainTrack";
import { displayText, maxCaptionWidth } from "./Captions";
// @ts-expect-error plain JS module without types
import { FONT_COPY } from "../../../scripts/copy-fonts.mjs";

const words = [
  { w: "Hello", s: 1, e: 1.4 },
  { w: "world", s: 1.5, e: 2 },
];

describe("entrance animation", () => {
  it("none is identity", () => {
    expect(entrance("none", 0, 30)).toEqual({ opacity: 1, scale: 1, translateY: 0 });
  });
  it("pop grows from small to 1 and overshoots then settles", () => {
    const a = entrance("pop", 0, 30);
    const z = entrance("pop", 30, 30);
    expect(a.scale).toBeCloseTo(0.6, 3);
    expect(z.scale).toBeCloseTo(1, 3);
    expect(z.opacity).toBe(1);
  });
  it("bounce settles at 1 via spring", () => {
    expect(entrance("bounce", 0, 30).scale).toBeCloseTo(0.4, 3);
    expect(entrance("bounce", 60, 30).scale).toBeCloseTo(1, 2);
    const mid = Math.max(...[3, 4, 5, 6, 7, 8, 9].map((f) => entrance("bounce", f, 30).scale));
    expect(mid).toBeGreaterThan(1); // overshoot
  });
  it("fade ramps opacity only", () => {
    const h = entrance("fade", 3, 30);
    expect(h.opacity).toBeGreaterThan(0);
    expect(h.opacity).toBeLessThan(1);
    expect(h.scale).toBe(1);
  });
  it("slide-up starts below and ends at 0", () => {
    expect(entrance("slide-up", 0, 30).translateY).toBeGreaterThan(50);
    expect(entrance("slide-up", 30, 30).translateY).toBeCloseTo(0, 5);
  });
  it("negative frames are clamped", () => {
    expect(entrance("pop", -5, 30)).toEqual(entrance("pop", 0, 30));
  });
});

describe("transitionStyle", () => {
  it("none/undefined are idle", () => {
    expect(transitionStyle("none", 0)).toEqual({ opacity: 1, translateX: 0, scale: 1, flash: 0 });
    expect(transitionStyle(undefined, 0).opacity).toBe(1);
  });
  it("fade goes 0 -> 1", () => {
    expect(transitionStyle("fade", 0).opacity).toBe(0);
    expect(transitionStyle("fade", 0.5).opacity).toBe(0.5);
    expect(transitionStyle("fade", 1).opacity).toBe(1);
  });
  it("slide moves from full width to 0", () => {
    expect(transitionStyle("slide", 0, 1080).translateX).toBe(1080);
    expect(transitionStyle("slide", 1, 1080).translateX).toBeCloseTo(0, 6);
  });
  it("zoom shrinks from 1.3 to 1", () => {
    expect(transitionStyle("zoom", 0).scale).toBeCloseTo(1.3, 6);
    expect(transitionStyle("zoom", 1).scale).toBeCloseTo(1, 6);
  });
  it("flash overlay fades out", () => {
    expect(transitionStyle("flash", 0).flash).toBe(1);
    expect(transitionStyle("flash", 1).flash).toBe(0);
  });
  it("clamps progress", () => {
    expect(transitionStyle("fade", 5).opacity).toBe(1);
    expect(transitionStyle("fade", -1).opacity).toBe(0);
  });
});

describe("hookEnvelope", () => {
  it("ramps in, holds, ramps out", () => {
    expect(hookEnvelope(0, 90, 30)).toBe(0);
    expect(hookEnvelope(45, 90, 30)).toBe(1);
    expect(hookEnvelope(90, 90, 30)).toBe(0);
    expect(hookEnvelope(4, 90, 30)).toBeCloseTo(4 / 9, 5);
  });
});

describe("caption fit", () => {
  it("never scales up and scales down proportionally", () => {
    expect(fitScale(500, 960)).toBe(1);
    expect(fitScale(1920, 960)).toBeCloseTo(0.5, 6);
    expect(fitScale(0, 960)).toBe(1);
  });
  it("fitLines uses the widest line plus padding", () => {
    const font = { fontFamily: "Montserrat", fontWeight: 900, fontSize: 100, letterSpacing: 0 };
    const wide = measureText("SUPERCALIFRAGILISTIC", font);
    const s = fitLines([["A"], ["SUPERCALIFRAGILISTIC"]], font, 28, 0, 960);
    expect(s).toBeCloseTo(Math.min(1, 960 / wide), 6);
    expect(s).toBeLessThan(1);
  });
  it("letter spacing widens measurements", () => {
    const a = { fontFamily: "Inter", fontWeight: 700, fontSize: 50, letterSpacing: 0 };
    expect(measureText("abc", { ...a, letterSpacing: 0.1 })).toBeGreaterThan(measureText("abc", a));
  });
  it("caption width honours safe zone side margins", () => {
    expect(maxCaptionWidth("none")).toBe(1080 - 96);
    expect(maxCaptionWidth("tiktok")).toBeLessThan(maxCaptionWidth("none"));
  });
  it("uppercase text transform", () => {
    expect(displayText("hi", { uppercase: true })).toBe("HI");
    expect(displayText("hi", { uppercase: false })).toBe("hi");
  });
});

describe("props", () => {
  it("resolveSrc keeps absolute urls and prefixes keys", () => {
    expect(resolveSrc("https://x/y.mp4", "http://h/")).toBe("https://x/y.mp4");
    expect(resolveSrc("a/b.mp4", "http://h/files")).toBe("http://h/files/a/b.mp4");
    expect(resolveSrc("/a/b.mp4", "http://h/")).toBe("http://h/a/b.mp4");
    expect(resolveSrc("a.png", "")).toBe("a.png");
  });
  it("derives the edit from clip", () => {
    const p = normalizeProps({ sourceUrl: "http://h/v.mp4", clip: { start: 1, end: 3, words, hook: "Big hook", styleId: "minimal" } });
    expect(p.edit.video).toHaveLength(1);
    expect(p.edit.video[0]).toMatchObject({ srcStart: 1, srcEnd: 3 });
    expect(p.edit.captions.styleId).toBe("minimal");
    expect(p.edit.hook).toMatchObject({ enabled: true, text: "Big hook" });
    expect(p.showSafeZone).toBe(false);
    expect(p.assetBaseUrl).toBe("");
  });
  it("uses srcW/srcH from crop track when missing", () => {
    const edit = createDefaultEditState({ start: 0, end: 2, words });
    const p = normalizeProps({ sourceUrl: "u", edit, cropTrack: { version: 1, srcW: 1280, srcH: 720, segments: [] } });
    expect([p.srcW, p.srcH]).toEqual([1280, 720]);
  });
  it("fills missing edit fields from old data", () => {
    const edit = createDefaultEditState({ start: 0, end: 2, words });
    const old = { ...edit } as Record<string, unknown>;
    delete old.broll;
    delete old.zooms;
    delete old.progressBar;
    const p = normalizeProps({ sourceUrl: "u", srcW: 10, srcH: 10, edit: old as unknown as typeof edit });
    expect(p.edit.broll).toEqual([]);
    expect(p.edit.zooms).toEqual([]);
    expect(p.edit.progressBar.enabled).toBe(false);
  });
  it("throws without edit or clip", () => {
    expect(() => normalizeProps({ sourceUrl: "u" })).toThrow();
  });
  it("duration sums pieces; hook does not extend it", () => {
    const edit = createDefaultEditState({ start: 0, end: 5, words });
    edit.video = [
      { id: "a", srcStart: 0, srcEnd: 2 },
      { id: "b", srcStart: 4, srcEnd: 5.5 },
    ];
    edit.hook = { enabled: true, text: "x", durationSec: 3 };
    expect(clipDurationInFrames(edit)).toBe(105);
    expect(clipDurationInFrames(edit, 60)).toBe(210);
  });
});

describe("pieceFrames", () => {
  it("tiles pieces without gaps or drift", () => {
    const pieces: VideoPiece[] = [
      { id: "a", srcStart: 0, srcEnd: 0.333 },
      { id: "b", srcStart: 1, srcEnd: 1.333 },
      { id: "c", srcStart: 2, srcEnd: 2.333 },
    ];
    const f = pieceFrames(pieces, 30);
    expect(f[0]!.from).toBe(0);
    expect(f[1]!.from).toBe(f[0]!.from + f[0]!.duration);
    expect(f[2]!.from).toBe(f[1]!.from + f[1]!.duration);
    expect(f[2]!.from + f[2]!.duration).toBe(Math.round(0.999 * 30));
  });
});

describe("fonts", () => {
  it("copy-fonts filenames match shared FONT_FILES", () => {
    const expected = Object.values(FONT_FILES).flatMap((f) => f.map((x) => x.file)).sort();
    expect(Object.keys(FONT_COPY).sort()).toEqual(expected);
  });
  it("woff2 files exist in public/fonts", () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/public/fonts");
    for (const files of Object.values(FONT_FILES)) {
      for (const f of files) expect(fs.statSync(path.join(dir, f.file)).size).toBeGreaterThan(1000);
    }
  });
});
