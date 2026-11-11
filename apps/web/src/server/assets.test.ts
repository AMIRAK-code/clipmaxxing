import { describe, expect, it } from "vitest";
import { HttpError } from "./http";
import { ASSET_EXT, MAX_ASSET_BYTES, validateAssetUpload } from "./assets";

const ID = "123e4567-e89b-12d3-a456-426614174000";
const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
  return undefined;
};

describe("validateAssetUpload", () => {
  it("accepts video, image and audio and stores assets/<uuid>.<ext>", () => {
    expect(validateAssetUpload({ name: "Clip.MP4", type: "video/mp4", size: 1000 }, ID)).toEqual({ kind: "video", ext: ".mp4", key: `assets/${ID}.mp4` });
    expect(validateAssetUpload({ name: "a.png", type: "image/png", size: 10 }, ID).kind).toBe("image");
    expect(validateAssetUpload({ name: "song.mp3", type: "audio/mpeg", size: 10 }, ID).kind).toBe("audio");
    expect(validateAssetUpload({ name: "vo.wav", type: "audio/wav", size: 10 }, ID).key).toBe(`assets/${ID}.wav`);
  });

  it("generates a uuid key by default", () => {
    const k = validateAssetUpload({ name: "a.jpg", type: "image/jpeg", size: 1 }).key;
    expect(k).toMatch(/^assets\/[0-9a-f-]{36}\.jpg$/);
  });

  it("allows a missing or generic content type when the extension is fine", () => {
    expect(validateAssetUpload({ name: "a.webm", type: "", size: 5 }, ID).kind).toBe("video");
    expect(validateAssetUpload({ name: "a.webm", type: "application/octet-stream", size: 5 }, ID).kind).toBe("video");
    expect(validateAssetUpload({ name: "a.m4a", type: "video/mp4", size: 5 }, ID).kind).toBe("audio");
  });

  it("rejects other types with 415", () => {
    expect(status(() => validateAssetUpload({ name: "a.exe", type: "application/x-msdownload", size: 5 }, ID))).toBe(415);
    expect(status(() => validateAssetUpload({ name: "a.html", type: "text/html", size: 5 }, ID))).toBe(415);
    expect(status(() => validateAssetUpload({ name: "noext", type: "video/mp4", size: 5 }, ID))).toBe(415);
    expect(status(() => validateAssetUpload({ name: "a.svg", type: "image/svg+xml", size: 5 }, ID))).toBe(415);
    expect(status(() => validateAssetUpload({ name: "a.mp4", type: "text/plain", size: 5 }, ID))).toBe(415);
    expect(status(() => validateAssetUpload({ name: "a.mp3", type: "video/webm", size: 5 }, ID))).toBe(415);
  });

  it("enforces the 500 MB limit (413) and rejects empty files (400)", () => {
    expect(MAX_ASSET_BYTES).toBe(500 * 1024 * 1024);
    expect(status(() => validateAssetUpload({ name: "a.mp4", type: "video/mp4", size: MAX_ASSET_BYTES }, ID))).toBeUndefined();
    expect(status(() => validateAssetUpload({ name: "a.mp4", type: "video/mp4", size: MAX_ASSET_BYTES + 1 }, ID))).toBe(413);
    expect(status(() => validateAssetUpload({ name: "a.mp4", type: "video/mp4", size: 0 }, ID))).toBe(400);
  });

  it("never lets the client name influence the storage path", () => {
    for (const name of ["../../etc/passwd.mp4", "..\\..\\x\\evil.mp4", "a/b/../../c.mp4", "x.mp4/../../y.png"]) {
      const r = validateAssetUpload({ name, type: "", size: 5 }, ID);
      expect(r.key).toBe(`assets/${ID}${r.ext}`);
      expect(r.key).not.toContain("..");
    }
    expect(status(() => validateAssetUpload({ name: "a.mp4", type: "video/mp4", size: 5 }, "../../evil"))).toBe(400);
  });

  it("only whitelists media extensions", () => {
    for (const ext of Object.keys(ASSET_EXT)) expect(ext).toMatch(/^\.[a-z0-9]+$/);
    expect(Object.keys(ASSET_EXT)).not.toContain(".html");
    expect(Object.keys(ASSET_EXT)).not.toContain(".svg");
  });
});
