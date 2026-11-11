import { describe, expect, it } from "vitest";
import { HttpError, assertSameOrigin } from "./http";

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:3000/api/x", { method: "POST", headers });

describe("assertSameOrigin", () => {
  it("accepts same-origin loopback requests and header-less clients", () => {
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ host: "localhost:3100", origin: "http://localhost:3100", "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000" }))).not.toThrow();
    expect(() => assertSameOrigin(req({ host: "[::1]:3000", origin: "http://[::1]:3000" }))).not.toThrow();
  });

  it("blocks cross-site origins and sec-fetch-site", () => {
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "https://evil.example" }))).toThrow(HttpError);
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" }))).toThrow(HttpError);
    expect(() => assertSameOrigin(req({ host: "127.0.0.1:3000", origin: "null" }))).toThrow(HttpError);
  });

  it("blocks DNS rebinding: matching Origin and Host on a foreign name", () => {
    expect(() => assertSameOrigin(req({ host: "evil.example:3000", origin: "http://evil.example:3000" }))).toThrow(/Host/);
  });
});
