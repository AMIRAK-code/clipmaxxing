import { describe, expect, it, beforeEach } from "vitest";
import { PublishError, type PublishArgs } from "@klipz/publishers";
import { PROVIDERS } from "@klipz/shared";
import { mockPublisher, resetMockState } from "./mock";

const ctx = { config: { clientId: "", clientSecret: "", redirectUri: "" } };
const args = (caption: string, provider = "x"): PublishArgs => ({
  tokens: { accessToken: "t", scopes: [] },
  account: { externalAccountId: `sandbox-${provider}`, displayName: "S", username: "s", meta: {} },
  render: { filePath: "/tmp/a.mp4", sizeBytes: 5e6, durationSec: 8, width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac", mimeType: "video/mp4" },
  meta: { caption, hashtags: [], options: {} },
});

beforeEach(() => resetMockState());

describe("sandbox publisher", () => {
  it("publishes as 'processing' then getStatus resolves to published with a fake non-routable URL", async () => {
    const p = mockPublisher("youtube");
    const r = await p.publish(ctx, args("hi", "youtube"));
    expect(r.status).toBe("processing");
    const s = await p.getStatus(ctx, { tokens: args("").tokens, account: args("").account, externalId: r.externalId });
    expect(s.status).toBe("published");
    expect(s.url).toMatch(/^https:\/\/sandbox\.invalid\//);
  });

  it("instagram returns a container id first and the media id on getStatus", async () => {
    const p = mockPublisher("instagram");
    const r = await p.publish(ctx, args("hi", "instagram"));
    expect(r.externalId.startsWith("container:")).toBe(true);
    const s = await p.getStatus(ctx, { tokens: args("").tokens, account: args("").account, externalId: r.externalId });
    expect(s.externalId).toMatch(/^ig_media_/);
  });

  it("[fail-once] fails retryably on the first attempt only; [fail-auth] needs reconnect; [fail-hard] is permanent", async () => {
    const p = mockPublisher("x");
    const e1 = await p.publish(ctx, args("a [fail-once]")).catch((e) => e as PublishError);
    expect(e1).toBeInstanceOf(PublishError);
    expect(e1).toMatchObject({ retryable: true, needsReconnect: false });
    await expect(p.publish(ctx, args("a [fail-once]"))).resolves.toMatchObject({ status: "processing" });
    expect(await p.publish(ctx, args("[fail-auth]")).catch((e) => e)).toMatchObject({ needsReconnect: true });
    expect(await p.publish(ctx, args("[fail-hard]")).catch((e) => e)).toMatchObject({ retryable: false, needsReconnect: false, code: "content_rejected" });
  });

  it("fetchMetrics grows on every call", async () => {
    const p = mockPublisher("tiktok");
    const ref = { tokens: args("").tokens, account: args("").account, externalId: "mock_tiktok_1" };
    const a = await p.fetchMetrics(ctx, ref);
    const b = await p.fetchMetrics(ctx, ref);
    expect(b.views!).toBeGreaterThan(a.views!);
  });

  it("validate delegates to the native validator for every provider", () => {
    for (const provider of PROVIDERS) {
      const issues = mockPublisher(provider).validate({ ...args("").render, durationSec: 100000 }, { caption: "", hashtags: [], options: {} });
      expect(issues.some((i) => i.severity === "error")).toBe(true);
    }
  });
});
