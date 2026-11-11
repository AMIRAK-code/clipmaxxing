import { createHash } from "node:crypto";
import type { Provider } from "@klipz/shared";
import {
  PLATFORM_LIMITS,
  PublishError,
  getNativePublisher,
  type AccountInfo,
  type ConnectResult,
  type PostMetrics,
  type PostMeta,
  type PostRefArgs,
  type PostStatus,
  type PublishArgs,
  type PublishResult,
  type Publisher,
  type PublisherContext,
  type RenderAsset,
  type TokenSet,
  type ValidationIssue,
} from "@klipz/publishers";

/**
 * Sandbox publisher (KLIPZ_PUBLISH_MOCK=1). Implements the full Publisher
 * interface in-process: nothing leaves the machine. Behaviour:
 *  - validate() is the real native validator.
 *  - publish() returns 'processing'; the next getStatus() returns 'published'
 *    with a fake URL (Instagram: 'container:<id>' -> real media id on getStatus).
 *  - caption markers inject failures: "[fail-once]" retryable error on the first
 *    attempt of that (provider, account, caption); "[fail-auth]" needsReconnect;
 *    "[fail-hard]" non-retryable. Attempt counting is per process (resetMockState()).
 *  - fetchMetrics() returns numbers that grow with every call.
 */

export const MOCK_MARKERS = { once: "[fail-once]", auth: "[fail-auth]", hard: "[fail-hard]" } as const;

const attempts = new Map<string, number>();
const metricCalls = new Map<string, number>();

export function resetMockState(): void {
  attempts.clear();
  metricCalls.clear();
}

const hash = (s: string): string => createHash("sha1").update(s).digest("hex");
const seedOf = (s: string): number => Number.parseInt(hash(s).slice(0, 6), 16);

export function mockPublisher(provider: Provider): Publisher {
  const native = getNativePublisher(provider);
  return {
    provider,
    limits: PLATFORM_LIMITS[provider],
    getAuthUrl: (_ctx: PublisherContext, args) => `/api/oauth/${provider}/callback?code=sandbox&state=${encodeURIComponent(args.state)}`,
    async connect(): Promise<ConnectResult> {
      const account: AccountInfo = { externalAccountId: `sandbox-${provider}`, displayName: `Sandbox ${provider}`, username: `sandbox_${provider}`, meta: { sandbox: true } };
      return { tokens: { accessToken: "sandbox-access-token", refreshToken: "sandbox-refresh-token", scopes: [] }, accounts: [account] };
    },
    async refresh(_ctx: PublisherContext, tokens: TokenSet): Promise<TokenSet> {
      return { ...tokens, accessToken: "sandbox-access-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    },
    validate(render: RenderAsset, meta: PostMeta, account?: AccountInfo): ValidationIssue[] {
      return native.validate(render, meta, account);
    },
    async publish(_ctx: PublisherContext, args: PublishArgs): Promise<PublishResult> {
      const caption = args.meta.caption ?? "";
      const key = `${provider}|${args.account.externalAccountId}|${caption}`;
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      if (caption.includes(MOCK_MARKERS.auth)) {
        throw new PublishError("Sandbox: token rejected (simulated)", { code: "auth_invalid", needsReconnect: true });
      }
      if (caption.includes(MOCK_MARKERS.hard)) {
        throw new PublishError("Sandbox: platform rejected the video (simulated)", { code: "content_rejected" });
      }
      if (caption.includes(MOCK_MARKERS.once) && n === 1) {
        throw new PublishError("Sandbox: temporary platform error (simulated)", { code: "server_error", retryable: true });
      }
      const id = hash(`${key}|${n}|${args.render.filePath ?? ""}`).slice(0, 12);
      return { externalId: provider === "instagram" ? `container:${id}` : `mock_${provider}_${id}`, status: "processing" };
    },
    async getStatus(_ctx: PublisherContext, args: PostRefArgs): Promise<PostStatus> {
      const raw = args.externalId.replace(/^container:/, "").replace(/^mock_[a-z]+_/, "");
      const realId = provider === "instagram" ? `ig_media_${raw}` : args.externalId;
      const status: PostStatus = { status: "published", url: fakeUrl(provider, args.account, realId) };
      if (realId !== args.externalId) status.externalId = realId;
      return status;
    },
    async fetchMetrics(_ctx: PublisherContext, args: PostRefArgs): Promise<PostMetrics> {
      const n = (metricCalls.get(args.externalId) ?? 0) + 1;
      metricCalls.set(args.externalId, n);
      const s = seedOf(args.externalId);
      const views = 120 * n + (s % 90) * n;
      return {
        views,
        likes: Math.round(views * 0.08),
        comments: Math.round(views * 0.01),
        shares: Math.round(views * 0.015),
        saves: provider === "instagram" || provider === "tiktok" ? Math.round(views * 0.02) : 0,
        impressions: Math.round(views * 1.4),
        watchTimeSec: Math.round(views * 6.5),
        raw: { sandbox: true, call: n },
      };
    },
  };
}

function fakeUrl(provider: Provider, account: AccountInfo, id: string): string {
  const user = account.username ?? "sandbox";
  switch (provider) {
    case "youtube":
      return `https://sandbox.invalid/youtube/shorts/${id}`;
    case "tiktok":
      return `https://sandbox.invalid/tiktok/@${user}/video/${id}`;
    case "instagram":
      return `https://sandbox.invalid/instagram/reel/${id}`;
    case "facebook":
      return `https://sandbox.invalid/facebook/reel/${id}`;
    case "x":
      return `https://sandbox.invalid/x/${user}/status/${id}`;
    case "linkedin":
      return `https://sandbox.invalid/linkedin/feed/update/${id}`;
  }
}

/** Account data stored for sandbox accounts (TikTok carries creator info like a real connect would). */
export function sandboxAccountMeta(provider: Provider): Record<string, unknown> {
  const meta: Record<string, unknown> = { sandbox: true };
  if (provider === "tiktok") meta.creatorInfo = mockTikTokCreatorInfo();
  return meta;
}

export function mockTikTokCreatorInfo() {
  return {
    creatorUsername: "sandbox_tiktok",
    creatorNickname: "Sandbox TikTok",
    privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const,
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    maxVideoPostDurationSec: 600,
  };
}
