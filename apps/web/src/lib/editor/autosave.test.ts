import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Autosaver, type FetchLike, type FetchResponse, type SaveInfo } from "./autosave";
import { sampleEdit } from "./fixtures";

const res = (status: number, body: unknown): FetchResponse => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function setup(handler: (call: { url: string; method: string; body: { edit_state?: unknown; expected_version?: number } }, n: number) => Promise<FetchResponse>, extra: Partial<ConstructorParameters<typeof Autosaver>[0]> = {}) {
  const calls: Array<{ url: string; method: string; body: { edit_state?: unknown; expected_version?: number }; keepalive?: boolean }> = [];
  const statuses: SaveInfo[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : {}, keepalive: init.keepalive };
    calls.push(call);
    return handler(call, calls.length);
  };
  const conflicts: unknown[] = [];
  const a = new Autosaver({
    clipId: "c1",
    version: 3,
    saved: sampleEdit(),
    fetchImpl,
    onStatus: (s) => statuses.push(s),
    onConflict: (s) => conflicts.push(s),
    ...extra,
  });
  return { a, calls, statuses, conflicts };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Autosaver", () => {
  it("debounces rapid changes into one PATCH with expected_version, then reports Saved", async () => {
    const { a, calls, statuses } = setup(async () => res(200, { clip: { edit_version: 4 } }));
    const e1 = sampleEdit();
    const e2 = { ...e1, look: "warm" as const };
    const e3 = { ...e1, look: "cool" as const };
    a.change(e1);
    a.change(e2);
    expect(a.currentStatus).toBe("dirty");
    await vi.advanceTimersByTimeAsync(700);
    expect(calls).toHaveLength(0);
    a.change(e3);
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "/api/clips/c1", method: "PATCH" });
    expect(calls[0]!.body.expected_version).toBe(3);
    expect((calls[0]!.body.edit_state as { look: string }).look).toBe("cool");
    expect(a.currentStatus).toBe("saved");
    expect(a.currentVersion).toBe(4);
    expect(statuses.map((s) => s.status)).toEqual(["dirty", "dirty", "dirty", "saving", "saved"]);
  });

  it("uses the new version for the next save and re-saves edits made while saving", async () => {
    let release: (r: FetchResponse) => void = () => undefined;
    const { a, calls } = setup((_c, n) => (n === 1 ? new Promise((r) => (release = r)) : Promise.resolve(res(200, { clip: { edit_version: 5 } }))));
    a.change({ ...sampleEdit(), look: "warm" });
    await vi.advanceTimersByTimeAsync(800);
    expect(a.currentStatus).toBe("saving");
    a.change({ ...sampleEdit(), look: "cool" }); // arrives mid-flight
    release(res(200, { clip: { edit_version: 4 } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.currentStatus).toBe("dirty");
    await vi.advanceTimersByTimeAsync(800);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.expected_version).toBe(4);
    expect(a.currentStatus).toBe("saved");
    expect(a.currentVersion).toBe(5);
  });

  it("retries network failures with backoff and never drops the edit", async () => {
    const { a, calls, statuses } = setup(async (_c, n) => {
      if (n <= 2) throw new Error("offline");
      return res(200, { clip: { edit_version: 4 } });
    });
    a.change({ ...sampleEdit(), look: "warm" });
    await vi.advanceTimersByTimeAsync(800);
    expect(a.currentStatus).toBe("error");
    expect(statuses.at(-1)).toMatchObject({ status: "error", retryInMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    expect(statuses.at(-1)).toMatchObject({ status: "error", retryInMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(3);
    expect(a.currentStatus).toBe("saved");
    // every attempt carried the same edit
    expect(new Set(calls.map((c) => JSON.stringify(c.body.edit_state))).size).toBe(1);
  });

  it("retries 5xx but not 400s", async () => {
    const s5 = setup(async (_c, n) => (n === 1 ? res(500, { error: "boom" }) : res(200, { clip: { edit_version: 4 } })));
    s5.a.change({ ...sampleEdit(), look: "warm" });
    await vi.advanceTimersByTimeAsync(800 + 1000);
    expect(s5.calls).toHaveLength(2);
    expect(s5.a.currentStatus).toBe("saved");

    const s4 = setup(async () => res(400, { error: "bad edit" }));
    s4.a.change({ ...sampleEdit(), look: "warm" });
    await vi.advanceTimersByTimeAsync(800 + 60_000);
    expect(s4.calls).toHaveLength(1);
    expect(s4.statuses.at(-1)).toMatchObject({ status: "error", message: "bad edit" });
  });

  it("on 409 reloads the server version, tells the editor, and stops", async () => {
    const server = { ...sampleEdit(), look: "vivid" as const };
    let patches = 0;
    const { a, calls, conflicts, statuses } = setup(async (c) => {
      if (c.method === "GET") return res(200, { clip: { edit_state: server, edit_version: 9 } });
      patches += 1;
      return patches === 1 ? res(409, { error: "changed elsewhere" }) : res(200, { clip: { edit_version: 10 } });
    });
    a.change({ ...sampleEdit(), look: "warm" });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.map((c) => c.method)).toEqual(["PATCH", "GET"]);
    expect(conflicts).toEqual([{ edit_state: server, edit_version: 9 }]);
    expect(a.currentStatus).toBe("conflict");
    expect(statuses.at(-1)?.message).toMatch(/newer version/i);
    expect(a.currentVersion).toBe(9);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2); // no retry loop
    // the reloaded edit counts as saved: setting it again does not trigger a save
    a.change(server);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(2);
    // the next real edit saves against the new version
    const fresh = { ...server, look: "bw" as const };
    a.change(fresh);
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH" });
    expect(calls.at(-1)!.body.expected_version).toBe(9);
    expect(a.currentVersion).toBe(10);
  });

  it("flush() saves immediately and resolves true; false when the save fails", async () => {
    const ok = setup(async () => res(200, { clip: { edit_version: 4 } }));
    ok.a.change({ ...sampleEdit(), look: "warm" });
    const p = ok.a.flush();
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe(true);
    expect(ok.calls).toHaveLength(1);

    const bad = setup(async () => res(400, { error: "no" }));
    bad.a.change({ ...sampleEdit(), look: "warm" });
    const q = bad.a.flush();
    await vi.advanceTimersByTimeAsync(0);
    await expect(q).resolves.toBe(false);
  });

  it("flush() with nothing pending is a no-op that resolves true", async () => {
    const { a, calls } = setup(async () => res(200, {}));
    await expect(a.flush()).resolves.toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("flushOnHide fires a keepalive PATCH for unsaved edits only", async () => {
    const { a, calls } = setup(async () => res(200, { clip: { edit_version: 4 } }));
    a.flushOnHide();
    expect(calls).toHaveLength(0);
    a.change({ ...sampleEdit(), look: "warm" });
    a.flushOnHide();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "PATCH", keepalive: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(1); // debounce timer was cleared
  });

  it("returning to the persisted edit cancels the pending save", async () => {
    const base = sampleEdit();
    const { a, calls } = setup(async () => res(200, { clip: { edit_version: 4 } }), { saved: base });
    a.change({ ...base, look: "warm" });
    a.change(base);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(0);
    expect(a.currentStatus).toBe("saved");
  });

  it("persists an initial edit when nothing was saved yet", async () => {
    const { a, calls } = setup(async () => res(200, { clip: { edit_version: 1 } }), { saved: null, version: 0 });
    a.change(sampleEdit());
    await vi.advanceTimersByTimeAsync(800);
    expect(calls[0]!.body.expected_version).toBe(0);
    expect(a.currentVersion).toBe(1);
  });
});
