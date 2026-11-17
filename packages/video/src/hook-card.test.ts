import { describe, expect, it } from "vitest";
import { createDefaultEditState, type EditState } from "@klipz/shared";
import { hookCardLayout, hookLines } from "./Overlays";

function edit(hook: Partial<EditState["hook"]>): EditState {
  const e = createDefaultEditState({ start: 0, end: 5, words: [] });
  return { ...e, hook: { ...e.hook, enabled: true, text: "Nobody tells you this", ...hook } };
}

describe("hook card layout", () => {
  it("an edit without a style draws the original purple card", () => {
    const { lines, style } = hookCardLayout(edit({}));
    expect(lines).toEqual(["NOBODY TELLS", "YOU THIS"]);
    expect(style).toEqual({
      textAlign: "center",
      direction: "ltr",
      fontFamily: '"Montserrat", "Vazirmatn", sans-serif',
      fontWeight: 900,
      fontSize: 92,
      lineHeight: 1.1,
      color: "#FFFFFF",
      background: "rgba(124,58,237,0.92)",
      padding: "28px 40px",
      borderRadius: 32,
      boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
      whiteSpace: "nowrap",
    });
  });

  it("draws the chosen font, colours, size and outline; padding and shadow follow the size", () => {
    const { lines, style } = hookCardLayout(
      edit({ styleId: "clean-white", overrides: { fontFamily: "Poppins", fontSize: 46, color: "#ff0000", strokeWidth: 6, strokeColor: "#00ff00" } }),
    );
    expect(lines).toEqual(["Nobody tells", "you this"]); // not uppercased
    expect(style).toMatchObject({
      fontFamily: '"Poppins", "Vazirmatn", sans-serif',
      fontWeight: 800,
      fontSize: 46,
      color: "#ff0000",
      background: "#FFFFFF",
      padding: "14px 20px",
      borderRadius: 16,
      boxShadow: "0 5px 20px rgba(0,0,0,0.5)",
      WebkitTextStroke: "6px #00ff00",
      paintOrder: "stroke fill",
    });
  });

  it("text alone: no card and no shadow", () => {
    const { style } = hookCardLayout(edit({ styleId: "outline" }));
    expect(style).toMatchObject({ background: "transparent", boxShadow: "none", WebkitTextStroke: "12px #000000" });
  });

  it("wraps at 14 characters", () => {
    expect(hookLines("A VERY LONGWORDTHATDOESNOTFIT B")).toEqual(["A VERY", "LONGWORDTHATDOESNOTFIT", "B"]);
  });
});
