import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOOK_STYLE_ID,
  FONT_FILES,
  HOOK_PRESETS,
  createDefaultEditState,
  fontWeightOf,
  isTransparent,
  resolveHookStyle,
} from "./index";

describe("hook card styles", () => {
  it("the default preset is the card every clip had before styles existed", () => {
    expect(HOOK_PRESETS[0]!.id).toBe(DEFAULT_HOOK_STYLE_ID);
    expect(resolveHookStyle(undefined)).toEqual(HOOK_PRESETS[0]);
    expect(resolveHookStyle({})).toMatchObject({
      fontFamily: "Montserrat",
      fontSize: 92,
      uppercase: true,
      color: "#FFFFFF",
      background: "rgba(124,58,237,0.92)",
      strokeWidth: 0,
    });
    expect(fontWeightOf("Montserrat")).toBe(900);
  });

  it("a fresh edit sets no style, so its saved JSON is unchanged", () => {
    const edit = createDefaultEditState({ start: 0, end: 5, words: [], hook: "Hi" });
    expect(Object.keys(edit.hook).sort()).toEqual(["durationSec", "enabled", "text"]);
  });

  it("resolves preset + overrides; unknown ids fall back to the default", () => {
    expect(resolveHookStyle({ styleId: "outline" })).toMatchObject({ fontFamily: "Anton", background: "transparent", strokeWidth: 12 });
    expect(resolveHookStyle({ styleId: "yellow-box", overrides: { color: "#ff0000" } })).toMatchObject({
      id: "yellow-box",
      color: "#ff0000",
      background: "#FFD60A",
    });
    expect(resolveHookStyle({ styleId: "gone" }).id).toBe(DEFAULT_HOOK_STYLE_ID);
  });

  it("every preset uses a bundled font and plain colours", () => {
    expect(new Set(HOOK_PRESETS.map((p) => p.id)).size).toBe(HOOK_PRESETS.length);
    for (const p of HOOK_PRESETS) {
      expect(FONT_FILES[p.fontFamily], p.id).toBeDefined();
      expect(fontWeightOf(p.fontFamily)).toBe(FONT_FILES[p.fontFamily]![0]!.weight);
      for (const c of [p.color, p.background, p.strokeColor]) expect(c, p.id).toMatch(/^(#[0-9A-F]{6}|rgba\([\d,.]+\)|transparent)$/i);
    }
  });

  it("isTransparent", () => {
    for (const c of ["transparent", "", "none", "rgba(0,0,0,0)", "rgba(10, 20, 30, 0.0)", "rgb(0 0 0 / 0)", "#11223300", "#0000"]) {
      expect(isTransparent(c), c).toBe(true);
    }
    for (const c of ["#000000", "#000", "rgb(0,0,0)", "rgba(124,58,237,0.92)", "rgb(0 0 0 / 0.5)", "white", "#112233ff"]) {
      expect(isTransparent(c), c).toBe(false);
    }
  });
});
