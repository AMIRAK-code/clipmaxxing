import { describe, expect, it } from "vitest";
import { isTypingTarget, matchShortcut, nextShuttleRate } from "./shortcuts";

describe("shortcut matcher", () => {
  it.each([
    [{ key: " " }, "playPause"],
    [{ key: "ArrowLeft" }, "stepBack"],
    [{ key: "ArrowRight" }, "stepForward"],
    [{ key: "ArrowLeft", shiftKey: true }, "stepBackSec"],
    [{ key: "ArrowRight", shiftKey: true }, "stepForwardSec"],
    [{ key: "j" }, "shuttleBack"],
    [{ key: "k" }, "shuttlePause"],
    [{ key: "L" }, "shuttleForward"],
    [{ key: "s" }, "split"],
    [{ key: "Delete" }, "delete"],
    [{ key: "Backspace" }, "delete"],
    [{ key: "z", ctrlKey: true }, "undo"],
    [{ key: "z", metaKey: true }, "undo"],
    [{ key: "Z", ctrlKey: true, shiftKey: true }, "redo"],
    [{ key: "y", ctrlKey: true }, "redo"],
    [{ key: "s", ctrlKey: true }, "save"],
    [{ key: "+" }, "zoomIn"],
    [{ key: "=" }, "zoomIn"],
    [{ key: "-" }, "zoomOut"],
    [{ key: "Home" }, "home"],
    [{ key: "End" }, "end"],
    [{ key: "?", shiftKey: true }, "help"],
  ] as const)("%j -> %s", (e, action) => {
    expect(matchShortcut(e)).toBe(action);
  });

  it("ignores unrelated keys, alt chords and unknown ctrl chords", () => {
    expect(matchShortcut({ key: "a" })).toBeNull();
    expect(matchShortcut({ key: "s", altKey: true })).toBeNull();
    expect(matchShortcut({ key: "c", ctrlKey: true })).toBeNull();
    expect(matchShortcut({ key: "Enter" })).toBeNull();
  });

  it("Ctrl+S is save, never split", () => {
    expect(matchShortcut({ key: "s", ctrlKey: true })).toBe("save");
  });

  it("knows which targets are text entry", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("shuttle speeds up when repeated and resets on direction change", () => {
    expect(nextShuttleRate(0, "shuttleBack")).toBe(-1);
    expect(nextShuttleRate(-1, "shuttleBack")).toBe(-2);
    expect(nextShuttleRate(-4, "shuttleBack")).toBe(-4);
    expect(nextShuttleRate(2, "shuttleBack")).toBe(-1);
    expect(nextShuttleRate(-2, "shuttlePause")).toBe(0);
  });
});
