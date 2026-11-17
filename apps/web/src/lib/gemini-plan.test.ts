import { describe, expect, it } from "vitest";
import { extractJson, parsePlan, parseTime, PlanError, type PlanVideo } from "./gemini-plan";

const one: PlanVideo[] = [{ id: "src-a", name: "talk.mp4", durationSec: 600 }];
const two: PlanVideo[] = [...one, { id: "src-b", name: "Party Night.mov", durationSec: 120 }];

describe("parseTime", () => {
  it("reads seconds and clock times", () => {
    expect(parseTime(72.4)).toBe(72.4);
    expect(parseTime("72.4")).toBe(72.4);
    expect(parseTime("72.4s")).toBe(72.4);
    expect(parseTime("1:12.4")).toBeCloseTo(72.4);
    expect(parseTime("01:12")).toBe(72);
    expect(parseTime("0:01:12.400")).toBeCloseTo(72.4);
    expect(parseTime("00:01:12,400")).toBeCloseTo(72.4);
    expect(parseTime("soon")).toBeNull();
    expect(parseTime(-1)).toBeNull();
  });
});

describe("extractJson", () => {
  it("finds the JSON in a fenced or chatty answer", () => {
    expect(extractJson('```json\n{"clips": []}\n```')).toEqual({ clips: [] });
    expect(extractJson('Here you go:\n[{"start": 1, "end": 2}]\nEnjoy!')).toEqual([{ start: 1, end: 2 }]);
    expect(() => extractJson("no json here")).toThrow(PlanError);
  });
});

describe("parsePlan", () => {
  it("reads the shape the prompt asks for", () => {
    const plan = parsePlan(
      JSON.stringify({
        clips: [
          { title: "The secret", text_on_screen: "Nobody tells you this", segments: [{ start: 12.4, end: 19.8 }, { start: "0:31", end: "0:44.2" }] },
        ],
      }),
      one,
    );
    expect(plan.warnings).toEqual([]);
    expect(plan.clips).toEqual([
      { title: "The secret", hook: "Nobody tells you this", segments: [{ source: "src-a", start: 12.4, end: 19.8 }, { source: "src-a", start: 31, end: 44.2 }] },
    ]);
  });

  it("maps video numbers and file names to the project's videos", () => {
    const plan = parsePlan(
      `\`\`\`json
[{"hook": "Mix", "segments": [{"video": 1, "start": 5, "end": 9}, {"video": "2", "start": 3, "end": 6},
  {"video": "Party Night", "start": 10, "end": 12}, {"video": "video_light_2.mp4", "start": 20, "end": 22}]}]
\`\`\``,
      two,
    );
    expect(plan.clips[0]!.segments.map((s) => s.source)).toEqual(["src-a", "src-b", "src-b", "src-b"]);
    expect(plan.clips[0]!.hook).toBe("Mix");
  });

  it("accepts other key names and a clip-level start / end", () => {
    const plan = parsePlan(JSON.stringify({ shorts: [{ name: "A", hook: "H", start_time: "00:00:05", end_time: "00:00:20" }] }), one);
    expect(plan.clips).toEqual([{ title: "A", hook: "H", segments: [{ source: "src-a", start: 5, end: 20 }] }]);
  });

  it("skips bad segments with a reason and shortens ones that run past the end", () => {
    const plan = parsePlan(
      JSON.stringify({
        clips: [
          { title: "ok", segments: [{ start: 590, end: 700 }, { start: 30, end: 20 }, { start: 900, end: 910 }, { start: "x", end: 3 }] },
          { title: "empty", segments: [] },
        ],
      }),
      one,
    );
    expect(plan.clips).toHaveLength(1);
    expect(plan.clips[0]!.segments).toEqual([{ source: "src-a", start: 590, end: 600 }]);
    expect(plan.warnings.join(" ")).toMatch(/shortened/);
    expect(plan.warnings.join(" ")).toMatch(/ends before it starts/);
    expect(plan.warnings.join(" ")).toMatch(/starts after the end/);
    expect(plan.warnings.join(" ")).toMatch(/no readable start/);
    expect(plan.warnings.join(" ")).toMatch(/empty.*no usable segment/);
  });

  it("asks which video when there are several and none is named", () => {
    expect(() => parsePlan(JSON.stringify({ clips: [{ segments: [{ start: 1, end: 3 }] }] }), two)).toThrow(/which video/);
  });

  it("refuses empty or clip-less input", () => {
    expect(() => parsePlan("   ", one)).toThrow(PlanError);
    expect(() => parsePlan('{"answer": 42}', one)).toThrow(/No clips/);
  });
});
