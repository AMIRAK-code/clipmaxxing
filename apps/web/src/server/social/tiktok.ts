import {
  TIKTOK_BRANDED_CONTENT_POLICY_URL,
  TIKTOK_BRANDED_PRIVACY_NOTICE,
  TIKTOK_CONSENT_TEXT,
  TIKTOK_CONSENT_TEXT_BRANDED,
  TIKTOK_DISCLOSURE_PROMPT,
  TIKTOK_LABEL_PAID_PARTNERSHIP,
  TIKTOK_LABEL_PROMOTIONAL,
  TIKTOK_MUSIC_USAGE_URL,
  ensureFreshTokens,
  getTikTokCreatorInfo,
  isPublishError,
  type PublisherContext,
  type TikTokCreatorInfo,
} from "@klipz/publishers";
import { get, nowIso, run } from "../db";
import { HttpError } from "../http";
import { getAccount } from "../repo";
import { configOrPlaceholder, providerConfig, sandboxMode } from "./config";
import { markNeedsReconnect } from "./accounts";
import { mockTikTokCreatorInfo } from "./mock";
import { getPublisherFor } from "./publishers";
import { loadTokens, saveTokens } from "./vault";

export const TIKTOK_CONSENT = {
  text: TIKTOK_CONSENT_TEXT,
  brandedText: TIKTOK_CONSENT_TEXT_BRANDED,
  labelPromotional: TIKTOK_LABEL_PROMOTIONAL,
  labelPaidPartnership: TIKTOK_LABEL_PAID_PARTNERSHIP,
  brandedPrivacyNotice: TIKTOK_BRANDED_PRIVACY_NOTICE,
  disclosurePrompt: TIKTOK_DISCLOSURE_PROMPT,
  musicUsageUrl: TIKTOK_MUSIC_USAGE_URL,
  brandedContentPolicyUrl: TIKTOK_BRANDED_CONTENT_POLICY_URL,
};

/** Creator info for the TikTok audit UX (live API, or fixed mock data in sandbox mode). Also cached on the account so validate() can use it. */
export async function creatorInfoFor(accountId: string, deps: { fetchInfo?: (ctx: PublisherContext, accessToken: string) => Promise<TikTokCreatorInfo> } = {}) {
  const account = getAccount(accountId) ?? (() => { throw new HttpError(404, "Account not found"); })();
  if (account.provider !== "tiktok") throw new HttpError(400, "Not a TikTok account");
  let info: TikTokCreatorInfo;
  if (sandboxMode()) {
    info = { ...mockTikTokCreatorInfo(), privacyLevelOptions: [...mockTikTokCreatorInfo().privacyLevelOptions], creatorNickname: account.display_name };
  } else {
    if (account.via_aggregator) throw new HttpError(409, "Creator info is not available for aggregator-routed accounts");
    const cfg = providerConfig("tiktok") ?? configOrPlaceholder("tiktok");
    const ctx: PublisherContext = { config: cfg };
    const tokens = loadTokens(account.id);
    if (!tokens) throw new HttpError(409, "Account has no stored credentials, reconnect it");
    try {
      const publisher = getPublisherFor("tiktok");
      const fresh = await ensureFreshTokens(publisher, ctx, tokens);
      if (fresh.refreshed) saveTokens(account.id, fresh.tokens);
      info = await (deps.fetchInfo ? deps.fetchInfo(ctx, fresh.tokens.accessToken) : getTikTokCreatorInfo(ctx, fresh.tokens));
    } catch (e) {
      if (isPublishError(e) && e.needsReconnect) {
        markNeedsReconnect(account.id, e.message);
        throw new HttpError(409, "TikTok needs to be reconnected");
      }
      throw new HttpError(502, e instanceof Error ? e.message.slice(0, 200) : "TikTok creator info failed");
    }
  }
  const meta = get<{ meta: string }>("select meta from social_accounts where id = ?", accountId);
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(meta?.meta ?? "{}") as Record<string, unknown>;
  } catch {
    /* keep empty */
  }
  run("update social_accounts set meta = ?, updated_at = ? where id = ?", JSON.stringify({ ...cur, creatorInfo: info }), nowIso(), accountId);
  return { creatorInfo: info, consent: TIKTOK_CONSENT, sandbox: sandboxMode() };
}
