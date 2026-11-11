import { describe, expect, it } from "vitest";
import { clampFrame, clampPps, fitPps, formatRuler, MAX_PPS, MIN_PPS, rulerTicks, scrollAfterZoom, secToFrame, sliceByStart, tickStep, timeToX, xToTime } from "./timeline-math";

describe("timeline math", () => {
  it("converts time and pixels both ways", () => {
    expect(timeToX(2.5, 40)).toBe(100);
    expect(xToTime(100, 40)).toBe(2.5);
    expect(xToTime(timeToX(7.123, 83), 83)).toBeCloseTo(7.123);
  });

  it("clamps zoom", () => {
    expect(clampPps(0.1)).toBe(MIN_PPS);
    expect(clampPps(1e6)).toBe(MAX_PPS);
    expect(clampPps(50)).toBe(50);
  });

  it("fits a duration into a width", () => {
    expect(fitPps(10, 800)).toBe(80);
    expect(fitPps(0, 800)).toBe(60);
    expect(fitPps(10_000, 100)).toBe(MIN_PPS);
  });

  it("keeps the time under the cursor fixed when zooming", () => {
    const before = { scroll: 200, anchor: 300, pps: 40 };
    const t = (before.scroll + before.anchor) / before.pps;
    const next = scrollAfterZoom(before.scroll, before.anchor, before.pps, 80);
    expect((next + before.anchor) / 80).toBeCloseTo(t);
    expect(scrollAfterZoom(0, 0, 40, 10)).toBe(0);
  });

  it("picks readable ruler steps", () => {
    expect(tickStep(100)).toBe(1);
    expect(tickStep(10)).toBe(10);
    expect(tickStep(600)).toBe(0.2);
    for (const pps of [4, 10, 40, 100, 600]) expect(tickStep(pps) * pps).toBeGreaterThanOrEqual(70);
  });

  it("generates ticks only inside the window, majors labelled", () => {
    const ticks = rulerTicks(100, 5, 8);
    expect(ticks.length).toBeGreaterThan(3);
    expect(ticks.every((t) => t.t >= 4.5 && t.t <= 8.5)).toBe(true);
    const majors = ticks.filter((t) => t.major);
    expect(majors.every((t) => t.label !== null)).toBe(true);
    expect(ticks.find((t) => t.t === 6)?.label).toBe("0:06");
    expect(ticks.find((t) => t.t === 6)?.x).toBe(600);
  });

  it("formats ruler labels", () => {
    expect(formatRuler(65, 5)).toBe("1:05");
    expect(formatRuler(1.5, 0.5)).toBe("0:01.5");
  });

  it("selects only the items overlapping the window (virtualised rows)", () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4 }));
    const vis = sliceByStart(items, 100, 110);
    expect(vis.length).toBeGreaterThan(15);
    expect(vis.length).toBeLessThan(30);
    expect(vis.every((i) => i.end >= 100 && i.start <= 110)).toBe(true);
    expect(sliceByStart(items, 5000, 6000)).toHaveLength(0);
  });

  it("frame helpers", () => {
    expect(secToFrame(1.5)).toBe(45);
    expect(clampFrame(-3, 300)).toBe(0);
    expect(clampFrame(999, 300)).toBe(299);
    expect(clampFrame(10.4, 300)).toBe(10);
  });
});
