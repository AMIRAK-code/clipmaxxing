import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureBundle, pruneStale } from "../lib/bundle-cache.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "klipz-bundle-"));

describe("ensureBundle", () => {
  it("builds into a temp dir, moves it into place and reuses it", async () => {
    const root = path.join(tmp(), "cache");
    let builds = 0;
    const build = async (d: string) => {
      builds++;
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "index.html"), "x");
    };
    const a = await ensureBundle(root, "h1", build);
    const b = await ensureBundle(root, "h1", build);
    expect(a).toBe(path.join(root, "h1"));
    expect(b).toBe(a);
    expect(builds).toBe(1);
    expect(fs.readdirSync(root)).toEqual(["h1"]); // no leftover temp dirs
  });

  it("cleans the temp dir and rethrows when the build fails", async () => {
    const root = path.join(tmp(), "cache");
    await expect(
      ensureBundle(root, "h2", async (d) => {
        fs.mkdirSync(d, { recursive: true });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("does not delete a fresh bundle of another hash that may be in use", async () => {
    const root = path.join(tmp(), "cache");
    fs.mkdirSync(path.join(root, "other"), { recursive: true });
    fs.writeFileSync(path.join(root, "other", "index.html"), "y");
    await ensureBundle(root, "h3", async (d) => {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "index.html"), "x");
    });
    expect(fs.existsSync(path.join(root, "other", "index.html"))).toBe(true);
  });
});

describe("pruneStale", () => {
  it("removes only old entries and never the kept one", () => {
    const root = tmp();
    for (const n of ["keep", "old", "fresh"]) fs.mkdirSync(path.join(root, n));
    const old = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(path.join(root, "old"), old, old);
    fs.utimesSync(path.join(root, "keep"), old, old);
    expect(pruneStale(root, "keep")).toEqual(["old"]);
    expect(fs.readdirSync(root).sort()).toEqual(["fresh", "keep"]);
  });
  it("tolerates a missing cache dir", () => {
    expect(pruneStale(path.join(tmp(), "nope"), "x")).toEqual([]);
  });
});
