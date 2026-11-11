import { describe, expect, it } from "vitest";
import { areaPath, barGeometry, labelIndices, linePath, linePoints, linearScale, niceMax, niceTicks, share } from "./chart";

const box = { width: 400, height: 200, padL: 40, padR: 10, padT: 10, padB: 30 };

describe("niceMax / ticks", () => {
  it("rounds up to readable values", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(2300)).toBe(2500);
    expect(niceMax(2618)).toBe(5000);
    expect(niceMax(100)).toBe(100);
  });
  it("ticks start at 0 and end at the nice max", () => {
    expect(niceTicks(2618, 4)).toEqual([0, 1250, 2500, 3750, 5000]);
  });
});

describe("linearScale", () => {
  it("maps and inverts ranges (SVG y grows downwards)", () => {
    const y = linearScale(0, 100, 170, 10);
    expect(y(0)).toBe(170);
    expect(y(100)).toBe(10);
    expect(y(50)).toBe(90);
  });
  it("collapses a zero span to the middle", () => {
    expect(linearScale(5, 5, 0, 10)(5)).toBe(5);
  });
});

describe("bars and lines", () => {
  it("bar geometry sits on the baseline and heights are proportional", () => {
    const bars = barGeometry([0, 50, 100], box, 100);
    expect(bars).toHaveLength(3);
    expect(bars[0]!.h).toBe(0);
    expect(bars[2]!.y).toBe(10); // top of plot
    expect(bars[2]!.y + bars[2]!.h).toBe(170); // baseline
    expect(bars[1]!.h).toBeCloseTo(80, 5);
  });
  it("tiny non-zero values still get a visible bar", () => {
    expect(barGeometry([1, 1000], box, 1000)[0]!.h).toBeGreaterThanOrEqual(1);
  });
  it("line path and area path are well formed", () => {
    const pts = linePoints([0, 100], box, 100);
    expect(pts[0]!.y).toBe(170);
    expect(pts[1]!.y).toBe(10);
    expect(linePath(pts)).toMatch(/^M[\d.]+ 170 L[\d.]+ 10$/);
    expect(areaPath(pts, 170)).toMatch(/Z$/);
    expect(areaPath([], 170)).toBe("");
  });
});

describe("share / labelIndices", () => {
  it("share is clamped and safe on zero", () => {
    expect(share(5, 0)).toBe(0);
    expect(share(5, 10)).toBe(0.5);
    expect(share(20, 10)).toBe(1);
  });
  it("labelIndices keeps ends and caps the count", () => {
    expect(labelIndices(3, 6)).toEqual([0, 1, 2]);
    const idx = labelIndices(30, 5);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(29);
    expect(idx.length).toBeLessThanOrEqual(5);
  });
});

import { stackSegments } from "./chart";
describe("stackSegments", () => {
  it("stacks segments from the baseline upwards and ignores negatives", () => {
    const y = linearScale(0, 100, 170, 10);
    const segs = stackSegments([25, 25, -5, 50], y, 170);
    expect(segs[0]).toMatchObject({ y: 130, h: 40, from: 0, to: 25 });
    expect(segs[1]).toMatchObject({ y: 90, h: 40, from: 25, to: 50 });
    expect(segs[2]!.h).toBe(0);
    expect(segs[3]).toMatchObject({ y: 10, h: 80, to: 100 });
  });
});
