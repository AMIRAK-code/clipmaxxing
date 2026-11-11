import { describe, expect, it } from "vitest";
import { actionBlockReason, filterClips, rankClips, scoreTone, scorerLabel } from "./clip-ui";
import { moveEdge, nudgeStep, snapToBoundary, wordBoundaries } from "./trim";

const words = [
  { w: "a", s: 1.0, e: 1.4 },
  { w: "b", s: 1.5, e: 2.0 },
  { w: "c", s: 3.0, e: 3.5 },
];

describe("trim helpers", () => {
  it("collects sorted unique boundaries", () => {
    expect(wordBoundaries(words)).toEqual([1.0, 1.4, 1.5, 2.0, 3.0, 3.5]);
  });

  it("snaps to the nearest boundary within the threshold", () => {
    const b = wordBoundaries(words);
    expect(snapToBoundary(1.42, b)).toBe(1.4);
    expect(snapToBoundary(1.48, b)).toBe(1.5);
    expect(snapToBoundary(2.6, b)).toBe(2.6); // 0.4 from 2.0 / 0.4 from 3.0: too far
    expect(snapToBoundary(0.9, b)).toBe(1.0);
    expect(snapToBoundary(9, b)).toBe(9);
  });

  it("does not snap when disabled (Alt) or with no words", () => {
    expect(snapToBoundary(1.42, wordBoundaries(words), 0.25, true)).toBe(1.42);
    expect(snapToBoundary(1.42, [])).toBe(1.42);
  });

  it("moveEdge keeps length within 1..180 s and inside the source", () => {
    expect(moveEdge(10, 30, "start", 29.9, { duration: 100 })).toEqual([29, 30]);
    expect(moveEdge(10, 30, "end", 10.2, { duration: 100 })).toEqual([10, 11]);
    expect(moveEdge(10, 30, "start", -4, { duration: 100 })).toEqual([0, 30]);
    expect(moveEdge(10, 30, "end", 500, { duration: 100 })).toEqual([10, 100]);
    expect(moveEdge(0, 100, "end", 400, { duration: null })).toEqual([0, 180]);
    expect(moveEdge(50, 100, "start", 0, { duration: null })).toEqual([0, 100]);
    expect(moveEdge(150, 200, "start", 0, { duration: null })).toEqual([20, 200]);
  });

  it("nudges by 0.1 s, or 1 s with Shift", () => {
    expect(nudgeStep(false)).toBe(0.1);
    expect(nudgeStep(true)).toBe(1);
  });
});

describe("clip ui helpers", () => {
  const mk = (id: string, score: number | null, status: "candidate" | "kept" | "discarded", start = 0) =>
    ({ id, score, status, start_sec: start, end_sec: start + 10 }) as never;

  it("ranks by score and filters", () => {
    const ranked = rankClips([mk("a", 40, "candidate"), mk("b", 90, "kept"), mk("c", null, "candidate"), mk("d", 70, "discarded")]);
    expect(ranked.map((c) => c.id)).toEqual(["b", "d", "a", "c"]);
    const f = filterClips(ranked, "kept");
    expect(f.visible.map((c) => c.id)).toEqual(["b"]);
    expect(f.discarded.map((c) => c.id)).toEqual(["d"]);
    expect(filterClips(ranked, "all").visible).toHaveLength(3);
  });

  it("tones and scorer labels", () => {
    expect(scoreTone(80)).toBe("good");
    expect(scoreTone(60)).toBe("warn");
    expect(scoreTone(10)).toBe("bad");
    expect(scorerLabel({ scorer: "heuristic" } as never)).toBe("Heuristic");
    expect(scorerLabel({ scorer: "claude-sonnet" } as never)).toBe("Claude");
    expect(scorerLabel({ scorer: "anthropic" } as never)).toBe("Claude");
    expect(scorerLabel({ scorer: "ollama" } as never)).toBe("Ollama");
  });

  it("explains why actions are blocked", () => {
    const ready = { status: "ready" } as never;
    const job = (status: string) => ({ type: "analyze", status }) as never;
    expect(actionBlockReason(null, [], "analyze")).toMatch(/no source/);
    expect(actionBlockReason({ status: "importing" } as never, [], "analyze")).toMatch(/importing/);
    expect(actionBlockReason({ status: "deleted" } as never, [], "autoclip")).toMatch(/cleaned up/);
    expect(actionBlockReason(ready, [job("running")], "analyze")).toMatch(/Already/);
    expect(actionBlockReason(ready, [job("running")], "autoclip")).toBeNull();
    expect(actionBlockReason(ready, [job("failed")], "analyze")).toBeNull();
  });
});
