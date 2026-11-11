import { describe, expect, it } from "vitest";
import { canRedo, canUndo, commit, createHistory, redo, undo } from "./history";

interface S {
  n: number;
  list: string[];
  nested: { a: number };
}
const init = (): S => ({ n: 0, list: [], nested: { a: 1 } });

describe("history (immer patches)", () => {
  it("round-trips undo/redo for several kinds of change", () => {
    let h = createHistory(init());
    h = commit(h, (d) => void (d.n = 5), { now: 0 });
    h = commit(h, (d) => void d.list.push("x"), { now: 10_000 });
    h = commit(h, (d) => void (d.nested.a = 9), { now: 20_000 });
    const final = h.present;
    expect(final).toEqual({ n: 5, list: ["x"], nested: { a: 9 } });

    h = undo(undo(undo(h)));
    expect(h.present).toEqual(init());
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(true);

    h = redo(redo(redo(h)));
    expect(h.present).toEqual(final);
    expect(canRedo(h)).toBe(false);
  });

  it("does not record recipes that change nothing", () => {
    const h = createHistory(init());
    const same = commit(h, (d) => void (d.n = 0));
    expect(same).toBe(h);
    expect(commit(h, () => undefined)).toBe(h);
  });

  it("a new edit clears the redo stack", () => {
    let h = createHistory(init());
    h = commit(h, (d) => void (d.n = 1), { now: 0 });
    h = commit(h, (d) => void (d.n = 2), { now: 5000 });
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = commit(h, (d) => void (d.n = 7), { now: 9000 });
    expect(canRedo(h)).toBe(false);
    expect(h.present.n).toBe(7);
    expect(undo(h).present.n).toBe(1);
  });

  it("coalesces rapid changes of the same key into one undo step", () => {
    let h = createHistory(init());
    for (let i = 1; i <= 10; i++) h = commit(h, (d) => void (d.n = i), { key: "drag", now: i * 50 });
    expect(h.past).toHaveLength(1);
    expect(h.present.n).toBe(10);
    expect(undo(h).present.n).toBe(0);
    expect(redo(undo(h)).present.n).toBe(10);
  });

  it("coalesces nested multi-field changes and still undoes them in the right order", () => {
    let h = createHistory(init());
    h = commit(h, (d) => void (d.nested.a = 2), { key: "k", now: 0 });
    h = commit(h, (d) => {
      d.nested.a = 3;
      d.list.push("y");
    }, { key: "k", now: 100 });
    expect(h.past).toHaveLength(1);
    expect(undo(h).present).toEqual(init());
  });

  it("does not coalesce different keys or changes outside the time window", () => {
    let h = createHistory(init());
    h = commit(h, (d) => void (d.n = 1), { key: "a", now: 0 });
    h = commit(h, (d) => void (d.n = 2), { key: "b", now: 10 });
    h = commit(h, (d) => void (d.n = 3), { key: "b", now: 10 + 5000 });
    expect(h.past).toHaveLength(3);
  });

  it("never merges into an entry that was undone and redone", () => {
    let h = createHistory(init());
    h = commit(h, (d) => void (d.n = 1), { key: "k", now: 0 });
    h = redo(undo(h));
    h = commit(h, (d) => void (d.n = 2), { key: "k", now: 10 });
    expect(h.past).toHaveLength(2);
  });

  it("caps the history length", () => {
    let h = createHistory(init());
    for (let i = 1; i <= 260; i++) h = commit(h, (d) => void (d.n = i), { now: i * 10_000, cap: 200 });
    expect(h.past).toHaveLength(200);
    let back = h;
    for (let i = 0; i < 500; i++) back = undo(back);
    expect(back.present.n).toBe(60); // the oldest 60 steps fell off the stack
  });

  it("uses the default cap of 200", () => {
    let h = createHistory(init());
    for (let i = 1; i <= 230; i++) h = commit(h, (d) => void (d.n = i), { now: i * 10_000 });
    expect(h.past).toHaveLength(200);
  });
});
