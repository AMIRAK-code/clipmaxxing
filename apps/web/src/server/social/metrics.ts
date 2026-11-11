import type { Post, Provider } from "@klipz/shared";
import { ensureFreshTokens, isPublishError, type Publisher, type PublisherContext } from "@klipz/publishers";
import { all, get, run } from "../db";
import { getAccount } from "../repo";
import { accountInfoOf, markNeedsReconnect } from "./accounts";
import { contextFor, getPublisherFor } from "./publishers";
import { loadTokens, saveTokens } from "./vault";

export const METRICS_WINDOW_DAYS = 90;

export interface MetricsDeps {
  publisherFor?: (provider: Provider) => Publisher;
  ctxFor?: (provider: Provider, now: () => Date) => PublisherContext;
}

export interface MetricsSummary {
  considered: number;
  captured: number;
  skippedToday: number;
  failed: { postId: string; error: string }[];
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const n = (v: number | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/**
 * Snapshot metrics of every post published in the last 90 days, at most once
 * per UTC calendar day per post (post_metrics unique on post_id + captured_on);
 * `force` (the "Refresh metrics now" button) overwrites today's snapshot instead of skipping it.
 * Failures are recorded in the summary and skipped; needsReconnect flags the account.
 */
export async function pullMetrics(now: Date = new Date(), deps: MetricsDeps = {}, opts: { force?: boolean } = {}): Promise<MetricsSummary> {
  const sum: MetricsSummary = { considered: 0, captured: 0, skippedToday: 0, failed: [] };
  const today = dayOf(now);
  const since = new Date(now.getTime() - METRICS_WINDOW_DAYS * 86400_000).toISOString();
  const posts = all<Post>("select * from posts where status = 'published' and external_id is not null and published_at >= ? order by published_at", since);
  for (const post of posts) {
    sum.considered++;
    if (!opts.force && get("select 1 as x from post_metrics where post_id = ? and captured_on = ?", post.id, today)) {
      sum.skippedToday++;
      continue;
    }
    const account = post.social_account_id ? getAccount(post.social_account_id) : undefined;
    if (!account || account.status !== "active") {
      sum.failed.push({ postId: post.id, error: account ? "account needs reconnect" : "account disconnected" });
      continue;
    }
    try {
      const publisher = (deps.publisherFor ?? ((p: Provider) => getPublisherFor(p)))(post.provider);
      const ctx = (deps.ctxFor ?? ((p: Provider, c: () => Date) => contextFor(p, c)))(post.provider, () => now);
      const stored = loadTokens(account.id);
      if (!stored) throw new Error("no stored credentials");
      const fresh = await ensureFreshTokens(publisher, ctx, stored);
      if (fresh.refreshed) saveTokens(account.id, fresh.tokens);
      const m = await publisher.fetchMetrics(ctx, { tokens: fresh.tokens, account: accountInfoOf(account), externalId: post.external_id! });
      run(
        `insert into post_metrics (post_id, captured_on, views, likes, comments, shares, saves, impressions, watch_time_sec, raw)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (post_id, captured_on) do update set views = excluded.views, likes = excluded.likes, comments = excluded.comments,
           shares = excluded.shares, saves = excluded.saves, impressions = excluded.impressions, watch_time_sec = excluded.watch_time_sec, raw = excluded.raw`,
        post.id,
        today,
        n(m.views),
        n(m.likes),
        n(m.comments),
        n(m.shares),
        n(m.saves),
        n(m.impressions),
        typeof m.watchTimeSec === "number" ? m.watchTimeSec : null,
        JSON.stringify(m.raw ?? null),
      );
      sum.captured++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isPublishError(e) && e.needsReconnect) markNeedsReconnect(account.id, e.message);
      sum.failed.push({ postId: post.id, error: msg.slice(0, 300) });
      console.warn(`[metrics] ${post.provider} post ${post.id}: ${msg}`);
    }
  }
  return sum;
}
