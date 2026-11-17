import { describe, expect, it } from "vitest";
import { fieldNumber } from "./montage";

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
