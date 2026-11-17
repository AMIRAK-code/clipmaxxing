import type { MontageScene } from "@klipz/shared";
import { describe, expect, it } from "vitest";
import { fieldNumber, sceneTrimBounds } from "./montage";

describe("trimming a montage scene", () => {
  const scenes: MontageScene[] = [
    { id: "s0_0", s: 0, e: 3.2, from: "a", name: "a.mp4", score: 60 },
    { id: "s1_0", s: 3.2, e: 6, from: "b", name: "b.mp4", score: 70 },
  ];
  const clip = { min: 0, max: 11 };

  it("stays inside the piece's own scene, never into the next video's footage", () => {
    expect(sceneTrimBounds(scenes, { srcStart: 3.5 }, clip)).toEqual({ min: 3.2, max: 6 });
    expect(sceneTrimBounds(scenes, { srcStart: 0 }, clip)).toEqual({ min: 0, max: 3.2 });
  });

  it("leaves ordinary clips and pieces outside every scene alone", () => {
    expect(sceneTrimBounds(null, { srcStart: 3.5 }, clip)).toBe(clip);
    expect(sceneTrimBounds([], { srcStart: 3.5 }, clip)).toBe(clip);
    expect(sceneTrimBounds(scenes, { srcStart: 8 }, clip)).toBe(clip);
  });
});

describe("montage settings boxes", () => {
  it("keep what was typed within the limits, checked once the box is left", () => {
    expect(fieldNumber("14", 3, 120, 10)).toBe(14);
    expect(fieldNumber("1", 3, 120, 10)).toBe(3);
    expect(fieldNumber("500", 3, 180, 20)).toBe(180);
    expect(fieldNumber("12.5", 3, 120, 10)).toBe(12.5);
    expect(fieldNumber("4.6", 1, 20, 3, true)).toBe(5);
  });

  it("fall back to the old value when the box is empty or not a number", () => {
    expect(fieldNumber("", 3, 120, 10)).toBe(10);
    expect(fieldNumber("  ", 1, 20, 3, true)).toBe(3);
    expect(fieldNumber("abc", 3, 120, 10)).toBe(10);
  });
});
