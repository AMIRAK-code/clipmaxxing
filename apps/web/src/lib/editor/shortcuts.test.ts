import { describe, expect, it } from "vitest";
import { isTypingTarget, matchShortcut, nextShuttleRate, targetOwnsKey } from "./shortcuts";

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

describe("targetOwnsKey (shortcuts must not hijack widgets)", () => {
  it("range sliders keep the arrow, Home/End and Page keys but not Space", () => {
    const range = { tagName: "INPUT", type: "range" };
    for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp"]) expect(targetOwnsKey(range, k)).toBe(true);
    expect(targetOwnsKey(range, " ")).toBe(false);
  });
  it("selects, text fields and contenteditable own every key", () => {
    for (const k of ["ArrowLeft", " ", "j", "Delete"]) {
      expect(targetOwnsKey({ tagName: "SELECT" }, k)).toBe(true);
      expect(targetOwnsKey({ tagName: "INPUT", type: "text" }, k)).toBe(true);
      expect(targetOwnsKey({ tagName: "DIV", isContentEditable: true }, k)).toBe(true);
    }
  });
  it("buttons, links and checkboxes own Space (and only Space)", () => {
    for (const t of [{ tagName: "BUTTON" }, { tagName: "A" }, { tagName: "INPUT", type: "checkbox" }, { tagName: "SUMMARY" }]) {
      expect(targetOwnsKey(t, " ")).toBe(true);
      expect(targetOwnsKey(t, "ArrowLeft")).toBe(false);
    }
  });
  it("ARIA widgets own the keys their role implies", () => {
    expect(targetOwnsKey({ tagName: "DIV", role: "slider" }, "ArrowRight")).toBe(true);
    expect(targetOwnsKey({ tagName: "DIV", role: "tab" }, "ArrowRight")).toBe(true);
    expect(targetOwnsKey({ tagName: "DIV", role: "tab" }, " ")).toBe(true);
    expect(targetOwnsKey({ tagName: "DIV", role: "listbox" }, "ArrowDown")).toBe(true);
  });
  it("plain elements (body, divs) own nothing, so shortcuts work", () => {
    for (const k of ["ArrowLeft", " ", "j", "s"]) {
      expect(targetOwnsKey({ tagName: "BODY" }, k)).toBe(false);
      expect(targetOwnsKey({ tagName: "DIV" }, k)).toBe(false);
      expect(targetOwnsKey(null, k)).toBe(false);
    }
  });
});
