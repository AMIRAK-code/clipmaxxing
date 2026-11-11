import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-assets-route-"));
process.env.KLIPZ_DATA_DIR = tmp;

import { POST } from "@/app/api/assets/route";
import { MAX_MULTIPART_BYTES } from "./assets";

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const call = (req: Request) => POST(req, { params: Promise.resolve({}) } as never);
const base = { host: "127.0.0.1:3000" };

describe("POST /api/assets", () => {
  it("streams a raw upload to disk", async () => {
    const res = await call(new Request("http://127.0.0.1:3000/api/assets", { method: "POST", headers: { ...base, "content-type": "image/png", "x-filename": "a.png" }, body: Buffer.from("png-bytes") }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { key: string; size: number };
    expect(j.size).toBe(9);
    expect(fs.readFileSync(path.join(tmp, "storage", j.key), "utf8")).toBe("png-bytes");
  });

  it("refuses a large multipart body before buffering it", async () => {
    const res = await call(
      new Request("http://127.0.0.1:3000/api/assets", {
        method: "POST",
        headers: { ...base, "content-type": "multipart/form-data; boundary=x", "content-length": String(MAX_MULTIPART_BYTES + 10 * 1024 * 1024) },
        body: "--x--",
      }),
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/raw body/);
  });

  it("still accepts a small multipart upload", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(100)], "tiny.png", { type: "image/png" }));
    const enc = new Response(form); // serialises with the boundary, like a browser would
    const bytes = Buffer.from(await enc.arrayBuffer());
    const res = await call(
      new Request("http://127.0.0.1:3000/api/assets", { method: "POST", headers: { ...base, "content-type": enc.headers.get("content-type")!, "content-length": String(bytes.length) }, body: bytes }),
    );
    expect(res.status).toBe(200);
  });
});
