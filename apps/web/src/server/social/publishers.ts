import type { Provider } from "@klipz/shared";
import { getPublisher, withTikTokAudited, type AccountInfo, type Publisher, type PublisherContext, type PostMeta, type RenderAsset, type ValidationIssue } from "@klipz/publishers";
import { aggregator, configOrPlaceholder, sandboxMode } from "./config";
import { mockPublisher } from "./mock";

/** The publisher to use right now: sandbox mock, aggregator-routed, or the native adapter. */
export function getPublisherFor(provider: Provider, env: Record<string, string | undefined> = process.env): Publisher {
  if (sandboxMode(env)) return mockPublisher(provider);
  const agg = aggregator(env);
  return getPublisher(provider, agg ? { aggregator: agg } : {});
}

export function contextFor(provider: Provider, now?: () => Date, env: Record<string, string | undefined> = process.env): PublisherContext {
  return { config: configOrPlaceholder(provider, env), ...(now ? { now } : {}) };
}

/** publisher.validate() with the TikTok audit flag (env TIKTOK_AUDITED) attached to the account. */
export function validateFor(
  publisher: Publisher,
  render: RenderAsset,
  meta: PostMeta,
  account: AccountInfo,
  env: Record<string, string | undefined> = process.env,
): ValidationIssue[] {
  const acc = publisher.provider === "tiktok" ? withTikTokAudited(account, configOrPlaceholder("tiktok", env)) : account;
  return publisher.validate(render, meta, acc);
}
