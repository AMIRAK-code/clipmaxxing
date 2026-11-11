import { describe, expect, it } from "vitest";
import { trapTarget } from "./focus-trap";

describe("trapTarget", () => {
  it("wraps Tab from the last element to the first and Shift+Tab from the first to the last", () => {
    expect(trapTarget(3, 2, false)).toBe(0);
    expect(trapTarget(3, 0, true)).toBe(2);
  });
  it("leaves in-between moves to the browser", () => {
    expect(trapTarget(3, 1, false)).toBe(-1);
    expect(trapTarget(3, 1, true)).toBe(-1);
  });
  it("pulls focus back in when it escaped the dialog", () => {
    expect(trapTarget(3, -1, false)).toBe(0);
    expect(trapTarget(3, -1, true)).toBe(2);
  });
  it("keeps focus in place when nothing is focusable", () => {
    expect(trapTarget(0, -1, false)).toBe(-2);
  });
});
