import { describe, expect, it } from "vitest";
import { Playhead } from "./playhead";

describe("Playhead", () => {
  it("coalesces many frame updates into one notification per animation frame", () => {
    const queue: Array<() => void> = [];
    const p = new Playhead((cb) => queue.push(cb), () => undefined);
    const seen: number[] = [];
    p.subscribe((f) => seen.push(f));
    expect(seen).toEqual([0]);
    for (let f = 1; f <= 50; f++) p.set(f);
    expect(queue).toHaveLength(1);
    queue.shift()!();
    expect(seen).toEqual([0, 50]);
    p.set(51);
    expect(queue).toHaveLength(1);
    expect(p.current).toBe(51);
  });

  it("stops notifying after unsubscribe / dispose", () => {
    const queue: Array<() => void> = [];
    const p = new Playhead((cb) => queue.push(cb), () => undefined);
    const seen: number[] = [];
    const off = p.subscribe((f) => seen.push(f));
    off();
    p.set(5);
    queue.shift()!();
    expect(seen).toEqual([0]);
    p.dispose();
  });
});
