import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assetBaseToServer, keyToUrl, parseRange, resolveSafe, startStaticServer } from "../lib/static-server.mjs";

let root: string;
let outside: string;
let server: Awaited<ReturnType<typeof startStaticServer>>;
let base: string;
const body = Buffer.from("0123456789abcdefghij"); // 20 bytes

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-static-"));
  root = path.join(base, "storage");
  fs.mkdirSync(path.join(root, "sub dir"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.mp4"), body);
  fs.writeFileSync(path.join(root, "sub dir", "b.txt"), "hi");
  outside = path.join(base, "secret.txt");
  fs.writeFileSync(outside, "SECRET");
  server = await startStaticServer(root);
});
afterAll(async () => {
  await server.close();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("parseRange", () => {
  it("handles open, closed, suffix and bad ranges", () => {
    expect(parseRange(undefined, 20)).toBeNull();
    expect(parseRange("bytes=0-4", 20)).toEqual({ start: 0, end: 4 });
    expect(parseRange("bytes=5-", 20)).toEqual({ start: 5, end: 19 });
    expect(parseRange("bytes=-5", 20)).toEqual({ start: 15, end: 19 });
    expect(parseRange("bytes=10-999", 20)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=20-30", 20)).toBe("unsatisfiable");
    expect(parseRange("bytes=9-3", 20)).toBe("unsatisfiable");
    expect(parseRange("garbage", 20)).toBeNull();
  });
});

describe("resolveSafe", () => {
  it("keeps paths inside root and blocks traversal", () => {
    expect(resolveSafe("/data/storage", "/a/b.mp4")).toBe(path.resolve("/data/storage/a/b.mp4"));
    expect(resolveSafe("/data/storage", "/../secret")).toBeNull();
    expect(resolveSafe("/data/storage", "/a/%2e%2e/%2e%2e/secret")).toBeNull();
    expect(resolveSafe("/data/storage", "/%00x")).toBeNull();
    expect(resolveSafe("/data/storage", "/")).toBeNull();
    expect(resolveSafe("/data/storage", "/%E0%A4%A")).toBeNull();
  });
});

describe("http server", () => {
  const get = (p: string, headers: Record<string, string> = {}) => fetch(server.origin + p, { headers });
  it("serves a full file with Accept-Ranges and CORS", async () => {
    const r = await get("/a.mp4");
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("content-type")).toBe("video/mp4");
    expect(Buffer.from(await r.arrayBuffer()).equals(body)).toBe(true);
  });
  it("serves partial content", async () => {
    const r = await get("/a.mp4", { Range: "bytes=2-5" });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 2-5/20");
    expect(await r.text()).toBe("2345");
  });
  it("serves suffix ranges and 416", async () => {
    const r = await get("/a.mp4", { Range: "bytes=-3" });
    expect(r.status).toBe(206);
    expect(await r.text()).toBe("hij");
    const bad = await get("/a.mp4", { Range: "bytes=50-60" });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */20");
  });
  it("404s missing files and directories", async () => {
    expect((await get("/nope.mp4")).status).toBe(404);
    expect((await get("/sub%20dir")).status).toBe(404);
  });
  it("blocks traversal over real sockets", async () => {
    // fetch normalises ../ in URLs, so use a raw request with an encoded and a literal form
    const http = await import("node:http");
    const raw = (p: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: server.port, path: p, method: "GET" }, (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
        });
        req.on("error", reject);
        req.end();
      });
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/sub%20dir/../../secret.txt", "/..%2fsecret.txt"]) {
      const r = await raw(p);
      expect([403, 404]).toContain(r.status);
      expect(r.body).not.toContain("SECRET");
    }
  });
  it("keyToUrl encodes segments", () => {
    expect(keyToUrl("http://h:1", "sub dir/a b.mp4")).toBe("http://h:1/sub%20dir/a%20b.mp4");
    expect(keyToUrl("http://h:1", "/x\\y.mp4")).toBe("http://h:1/x/y.mp4");
  });
  it("serves keys with spaces", async () => {
    const r = await fetch(keyToUrl(server.origin, "sub dir/b.txt"));
    expect(await r.text()).toBe("hi");
  });
});

describe("assetBaseToServer", () => {
  const o = "http://127.0.0.1:1234";
  it("maps the web route prefix and empty values to the storage root", () => {
    expect(assetBaseToServer(o, "/api/files/")).toBe(`${o}/`);
    expect(assetBaseToServer(o, "api/files")).toBe(`${o}/`);
    expect(assetBaseToServer(o, "")).toBe(`${o}/`);
  });
  it("keeps a real storage sub folder", () => {
    expect(assetBaseToServer(o, "/broll/")).toBe(`${o}/broll/`);
  });
});

describe("resolveSafe dot-prefixed names", () => {
  it("allows names that merely start with two dots but still blocks traversal", () => {
    expect(resolveSafe("/data/storage", "/..hidden.txt")).not.toBeNull();
    expect(resolveSafe("/data/storage", "/../x")).toBeNull();
    expect(resolveSafe("/data/storage", "/%2e%2e/x")).toBeNull();
  });
});
