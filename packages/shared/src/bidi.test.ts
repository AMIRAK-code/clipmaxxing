import { describe, expect, it } from "vitest";
import { baseDirection, hasCursiveScript, layoutWordOrder, resolveWordDirections, wordDirection } from "./bidi";

// The same cases as apps/worker/tests/test_fastrender.py::test_word_order_follows_the_reading_direction:
// the Studio renderer (this code) and the fast renderer (bidi.py) must order words alike.
const order = (words: string[], base: "ltr" | "rtl") => layoutWordOrder(words, base).map((o) => words[o.index]);

describe("bidi", () => {
  it("takes the reading direction from the majority of the letters", () => {
    expect(baseDirection(["سلام", "iPhone", "دنیا"])).toBe("rtl");
    expect(baseDirection(["Hello", "سلام", "world"])).toBe("ltr");
    expect(baseDirection(["100%", "..."])).toBe("ltr");
    expect(wordDirection("سلام!")).toBe("rtl");
    expect(wordDirection("iPhone")).toBe("ltr");
    expect(wordDirection("۲۰۲۴")).toBeNull();
  });

  it("leaves left-to-right lines alone", () => {
    expect(order(["a", "b", "c"], "ltr")).toEqual(["a", "b", "c"]);
    expect(layoutWordOrder(["Why", "100", "people?"], "ltr")).toEqual([
      { index: 0, dir: "ltr" },
      { index: 1, dir: "ltr" },
      { index: 2, dir: "ltr" },
    ]);
  });

  it("runs right-to-left lines from the right", () => {
    expect(order(["سلام", "دنیا", "خوب"], "rtl")).toEqual(["خوب", "دنیا", "سلام"]);
    expect(resolveWordDirections(["قیمت", "۵۰", "است!"], "rtl")).toEqual(["rtl", "rtl", "rtl"]);
  });

  it("keeps a foreign phrase in its own order", () => {
    expect(order(["این", "Windows", "10", "Pro", "است"], "rtl")).toEqual(["است", "Windows", "10", "Pro", "این"]);
    expect(order(["سال", "2024", "میلادی"], "rtl")).toEqual(["میلادی", "2024", "سال"]);
    expect(order(["2024", "iPhone"], "rtl")).toEqual(["iPhone", "2024"]);
    expect(order(["he", "said", "سلام", "علیکم", "loudly"], "ltr")).toEqual(["he", "said", "علیکم", "سلام", "loudly"]);
  });

  it("knows which scripts join their letters", () => {
    expect(hasCursiveScript("سلام")).toBe(true);
    expect(hasCursiveScript("Hello 123 שלום")).toBe(false);
  });
});
