import { describe, expect, it } from "vitest";
import { getPublisher, type AccountInfo, type PostMeta, type RenderAsset } from "@klipz/publishers";
import { providerConfig, configOrPlaceholder } from "./config";
import { validateFor } from "./publishers";

const asset: RenderAsset = { filePath: "x.mp4", sizeBytes: 1_000_000, durationSec: 20, width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac", mimeType: "video/mp4" };
const account: AccountInfo = { externalAccountId: "t1", displayName: "T", meta: {} };
const metaFor = (privacyLevel: string): PostMeta => ({ caption: "hi", hashtags: [], options: { privacyLevel, consentAccepted: true } });
const tiktok = getPublisher("tiktok");
const codes = (env: Record<string, string>, privacy: string) => {
  const issues = validateFor(tiktok, asset, metaFor(privacy), account, env);
  return issues.filter((i) => i.severity === "warning").map((i) => i.code);
};

describe("TIKTOK_AUDITED", () => {
  it("unaudited: warns (non-blocking) for PUBLIC_TO_EVERYONE, not for SELF_ONLY", () => {
    expect(codes({}, "PUBLIC_TO_EVERYONE")).toContain("unaudited_app_forced_private");
    expect(codes({}, "SELF_ONLY")).not.toContain("unaudited_app_forced_private");
    const errs = validateFor(tiktok, asset, metaFor("PUBLIC_TO_EVERYONE"), account, {}).filter((i) => i.code === "unaudited_app_forced_private");
    expect(errs.every((i) => i.severity === "warning")).toBe(true);
  });

  it("audited: no warning", () => {
    expect(codes({ TIKTOK_AUDITED: "true" }, "PUBLIC_TO_EVERYONE")).not.toContain("unaudited_app_forced_private");
  });

  it("flag lands in config.extra only when exactly true", () => {
    const base = { TIKTOK_CLIENT_ID: "a", TIKTOK_CLIENT_SECRET: "b" };
    expect(providerConfig("tiktok", { ...base, TIKTOK_AUDITED: "true" })?.extra?.tiktokAudited).toBe("true");
    expect(providerConfig("tiktok", { ...base, TIKTOK_AUDITED: "false" })?.extra?.tiktokAudited).toBeUndefined();
    expect(providerConfig("tiktok", base)?.extra?.tiktokAudited).toBeUndefined();
  });
});

describe("KLIPZ_UPLOAD_MODE", () => {
  it("passes buffer through for instagram and facebook only (plus aggregator-routed providers)", () => {
    const meta = { META_APP_ID: "a", META_APP_SECRET: "b", KLIPZ_UPLOAD_MODE: "buffer" };
    expect(providerConfig("instagram", meta)?.extra?.uploadMode).toBe("buffer");
    expect(providerConfig("facebook", meta)?.extra?.uploadMode).toBe("buffer");
    expect(configOrPlaceholder("x", { KLIPZ_UPLOAD_MODE: "buffer" }).extra?.uploadMode).toBeUndefined();
    const agg = { KLIPZ_UPLOAD_MODE: "buffer", AGGREGATOR_KIND: "upload-post", AGGREGATOR_API_KEY: "k", AGGREGATOR_PROVIDERS: "x" };
    expect(configOrPlaceholder("x", agg).extra?.uploadMode).toBe("buffer");
  });
  it("ignores other values", () => {
    expect(providerConfig("instagram", { META_APP_ID: "a", META_APP_SECRET: "b", KLIPZ_UPLOAD_MODE: "stream" })?.extra?.uploadMode).toBeUndefined();
  });
});
