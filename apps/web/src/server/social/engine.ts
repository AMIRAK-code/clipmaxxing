import fs from "node:fs";
import type { Post, Provider, Render, SocialAccount } from "@klipz/shared";
import {
  backoffDelayMs,
  ensureFreshTokens,
  isPublishError,
  PublishError,
  type BackoffOptions,
  type PostMeta,
  type Publisher,
  type PublisherContext,
  type TokenSet,
} from "@klipz/publishers";
import { all, run } from "../db";
import { renderAssetOf } from "../renders";
import { getAccount, getPost, getRender } from "../repo";
import { accountInfoOf, markNeedsReconnect } from "./accounts";
import { contextFor, getPublisherFor } from "./publishers";
import { loadTokens, saveTokens } from "./vault";

/**
 * Publish engine. One tick (processDuePosts) does, in order:
 *  1. scheduled -> queued when scheduled_at <= now
 *  2. reclaim stale locks (older than LOCK_TTL_MS)
 *  3. claim due 'queued' (publish) and 'processing' (poll) posts atomically
 *  4. process each claimed post independently (one failing never affects another)
 *
 * Delivery is AT MOST ONCE. Just before publisher.publish() is called the post
 * is marked in flight (error_code = 'in_flight'). The result is persisted with a
 * single UPDATE right after publish() returns. If the process dies between those
 * two points the post stays 'publishing'; after the lock expires it is marked
 * failed ('uncertain_outcome') instead of being published again, because the
 * platform may already have the video. The user decides (retry / delete).
 * A post that has an external_id is only ever polled, never published.
 */

export const LOCK_TTL_MS = 10 * 60 * 1000;
export const POLL_DELAY_MS = 20 * 1000;
export const PROCESSING_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 30_000, maxMs: 30 * 60_000 };
const CONCURRENCY = 3;

export interface EngineDeps {
  publisherFor?: (provider: Provider) => Publisher;
  ctxFor?: (provider: Provider, now: () => Date) => PublisherContext;
  backoff?: BackoffOptions;
  /** Test hook: runs right after publish() returned, before its result is saved (simulates a crash when it throws). */
  afterPublishCall?: (post: Post) => void;
  /** How often the post lock is refreshed while a publish call is running (default LOCK_TTL_MS / 4). */
  heartbeatMs?: number;
  /** Clock used for heartbeat timestamps (default: wall clock; tests inject a fake one). */
  clock?: () => Date;
}

/**
 * Keep a post's lock fresh while a long upload runs so reclaimStale() never mistakes it for a dead
 * process. Only the process that holds the lock beats; if the process dies the beat stops and the
 * normal at-most-once reclaim (uncertain_outcome) applies after LOCK_TTL_MS.
 */
async function withHeartbeat<T>(postId: string, deps: EngineDeps, fn: () => Promise<T>): Promise<T> {
  const every = deps.heartbeatMs ?? LOCK_TTL_MS / 4;
  const timer = setInterval(() => {
    try {
      const t = iso((deps.clock ?? (() => new Date()))());
      run("update posts set locked_at = ? where id = ? and status = 'publishing' and locked_at is not null", t, postId);
    } catch {
      /* a failed beat must never break the upload; the next one retries */
    }
  }, every);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

export interface TickSummary {
  promoted: number;
  reclaimed: number;
  processed: number;
  published: number;
  processing: number;
  retried: number;
  failed: number;
  results: { postId: string; outcome: string }[];
}

const iso = (d: Date | number): string => new Date(d).toISOString();

/** Platform-supplied links end up in <a href>: only ever store http(s) URLs. */
export const safeUrl = (u: string | null | undefined): string | null => (u && /^https?:\/\//i.test(u) ? u : null);

export async function processDuePosts(now: Date = new Date(), deps: EngineDeps = {}): Promise<TickSummary> {
  const sum: TickSummary = { promoted: 0, reclaimed: 0, processed: 0, published: 0, processing: 0, retried: 0, failed: 0, results: [] };
  const nowS = iso(now);

  sum.promoted = run(
    "update posts set status = 'queued', next_attempt_at = scheduled_at, updated_at = ? where status = 'scheduled' and scheduled_at is not null and scheduled_at <= ?",
    nowS,
    nowS,
  ).changes;

  sum.reclaimed = reclaimStale(now);

  const claimed = claimDue(now);
  const queue = [...claimed];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        const outcome = await processPost(item.id, item.mode, now, deps);
        sum.processed++;
        sum.results.push({ postId: item.id, outcome });
        if (outcome === "published") sum.published++;
        else if (outcome === "processing") sum.processing++;
        else if (outcome === "retry") sum.retried++;
        else if (outcome === "failed") sum.failed++;
      } catch (e) {
        // Unexpected (e.g. DB write failed after publish): leave the row as is, see header comment.
        console.error(`[engine] post ${item.id} crashed mid-flight`, e);
        sum.results.push({ postId: item.id, outcome: "crashed" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  return sum;
}

function reclaimStale(now: Date): number {
  const cutoff = iso(now.getTime() - LOCK_TTL_MS);
  const nowS = iso(now);
  let n = 0;
  const stale = all<{ id: string; status: string; external_id: string | null; error_code: string | null }>(
    "select id, status, external_id, error_code from posts where status in ('publishing','processing') and locked_at is not null and locked_at < ?",
    cutoff,
  );
  for (const p of stale) {
    if (p.status === "processing") {
      n += run("update posts set locked_at = null, next_attempt_at = ?, updated_at = ? where id = ? and status = 'processing' and locked_at < ?", nowS, nowS, p.id, cutoff).changes;
    } else if (p.external_id) {
      n += run("update posts set status = 'processing', locked_at = null, error = null, error_code = null, next_attempt_at = ?, updated_at = ? where id = ? and status = 'publishing' and locked_at < ?", nowS, nowS, p.id, cutoff).changes;
    } else if (p.error_code === "in_flight") {
      n += run(
        `update posts set status = 'failed', locked_at = null, next_attempt_at = null, error_code = 'uncertain_outcome',
           error = 'KLIPZ stopped while this was being sent, so it may or may not have been posted. Check the platform, then retry or delete.', updated_at = ?
         where id = ? and status = 'publishing' and locked_at < ?`,
        nowS,
        p.id,
        cutoff,
      ).changes;
    } else {
      // Died before the publish call started (e.g. during token refresh): safe to queue again.
      n += run("update posts set status = 'queued', locked_at = null, next_attempt_at = ?, updated_at = ? where id = ? and status = 'publishing' and locked_at < ?", nowS, nowS, p.id, cutoff).changes;
    }
  }
  return n;
}

interface Claim {
  id: string;
  mode: "publish" | "poll";
}

function claimDue(now: Date): Claim[] {
  const nowS = iso(now);
  const cutoff = iso(now.getTime() - LOCK_TTL_MS);
  const due = all<{ id: string; status: string; external_id: string | null }>(
    `select id, status, external_id from posts
     where status in ('queued','processing') and next_attempt_at is not null and next_attempt_at <= ?
       and (locked_at is null or locked_at < ?) order by next_attempt_at, created_at`,
    nowS,
    cutoff,
  );
  const out: Claim[] = [];
  for (const p of due) {
    if (p.status === "queued" && !p.external_id) {
      const r = run(
        "update posts set status = 'publishing', locked_at = ?, attempts = attempts + 1, updated_at = ? where id = ? and status = 'queued' and (locked_at is null or locked_at < ?)",
        nowS,
        nowS,
        p.id,
        cutoff,
      );
      if (r.changes === 1) out.push({ id: p.id, mode: "publish" });
    } else {
      // processing, or (defensively) queued with an external id: poll only.
      const r = run(
        "update posts set locked_at = ?, updated_at = ? where id = ? and status = ? and (locked_at is null or locked_at < ?)",
        nowS,
        nowS,
        p.id,
        p.status,
        cutoff,
      );
      if (r.changes === 1) out.push({ id: p.id, mode: "poll" });
    }
  }
  return out;
}

type Outcome = "published" | "processing" | "retry" | "failed" | "skipped";

async function processPost(id: string, mode: "publish" | "poll", now: Date, deps: EngineDeps): Promise<Outcome> {
  const post = getPost(id);
  if (!post) return "skipped";
  const clock = () => now;
  const provider = post.provider;
  const account = post.social_account_id ? getAccount(post.social_account_id) : undefined;
  if (!account) return failPost(post, "account_missing", "The account was disconnected. Reconnect it and retry.", now);
  if (account.status !== "active") return failPost(post, "needs_reconnect", `${account.display_name} needs to be reconnected.${account.last_error ? " " + account.last_error : ""}`, now);

  const publisher = (deps.publisherFor ?? ((p: Provider) => getPublisherFor(p)))(provider);
  const ctx = (deps.ctxFor ?? ((p: Provider, n: () => Date) => contextFor(p, n)))(provider, clock);

  let tokens: TokenSet;
  try {
    const stored = loadTokens(account.id);
    if (!stored) return failPost(post, "account_missing", "The account has no stored credentials. Reconnect it.", now);
    const fresh = await ensureFreshTokens(publisher, ctx, stored);
    tokens = fresh.tokens;
    if (fresh.refreshed) saveTokens(account.id, fresh.tokens); // refresh tokens may rotate: persist immediately
  } catch (e) {
    return handleError(post, account, e, mode, now, deps);
  }

  if (mode === "poll" || post.external_id) return pollPost(post, account, publisher, ctx, tokens, now, deps);

  const render = post.render_id ? getRender(post.render_id) : undefined;
  const asset = render ? renderAssetOf(render as Render) : null;
  if (!render || !asset) return failPost(post, "render_missing", "The rendered video is gone. Re-render the clip and post again.", now);

  const meta: PostMeta = { caption: post.caption, hashtags: post.hashtags ?? [], options: post.options ?? {} };
  if (post.title) meta.title = post.title;
  if (post.cover_timestamp_ms != null) meta.coverTimestampMs = post.cover_timestamp_ms;

  if (!asset.filePath || !fs.existsSync(asset.filePath)) return failPost(post, "render_missing", "The rendered video file is missing on disk. Re-render the clip and post again.", now);

  // Mark in flight BEFORE the call (see header comment).
  run("update posts set error_code = 'in_flight', error = null, updated_at = ? where id = ?", iso(now), id);
  let result;
  try {
    result = await withHeartbeat(id, deps, () => publisher.publish(ctx, { tokens, account: accountInfoOf(account), render: asset, meta }));
  } catch (e) {
    return handleError(post, account, e, mode, now, deps);
  }
  deps.afterPublishCall?.(post);
  // Crash-safe: one statement records the platform id and the new state together.
  if (result.status === "published") {
    run(
      `update posts set status = 'published', external_id = ?, external_url = ?, published_at = ?, error = null, error_code = null,
         next_attempt_at = null, locked_at = null, updated_at = ? where id = ?`,
      result.externalId,
      safeUrl(result.url),
      iso(now),
      iso(now),
      id,
    );
    return "published";
  }
  run(
    `update posts set status = 'processing', external_id = ?, external_url = ?, error = null, error_code = null,
       next_attempt_at = ?, locked_at = null, updated_at = ? where id = ?`,
    result.externalId,
    safeUrl(result.url),
    iso(now.getTime() + POLL_DELAY_MS),
    iso(now),
    id,
  );
  return "processing";
}

async function pollPost(post: Post, account: SocialAccount, publisher: Publisher, ctx: PublisherContext, tokens: TokenSet, now: Date, deps: EngineDeps): Promise<Outcome> {
  const externalId = post.external_id;
  if (!externalId) return failPost(post, "status_check_failed", "No platform id to check.", now);
  const basis = Date.parse(post.scheduled_at ?? post.created_at);
  if (!Number.isNaN(basis) && now.getTime() - basis > PROCESSING_TIMEOUT_MS) {
    return failPost(post, "processing_timeout", `The platform has not finished processing this video after ${PROCESSING_TIMEOUT_MS / 3600000} hours.`, now);
  }
  try {
    const st = await publisher.getStatus(ctx, { tokens, account: accountInfoOf(account), externalId });
    const nextId = st.externalId && st.externalId !== externalId ? st.externalId : externalId;
    if (st.status === "published") {
      run(
        `update posts set status = 'published', external_id = ?, external_url = coalesce(?, external_url), published_at = ?, error = null, error_code = null,
           next_attempt_at = null, locked_at = null, updated_at = ? where id = ?`,
        nextId,
        safeUrl(st.url),
        iso(now),
        iso(now),
        post.id,
      );
      return "published";
    }
    if (st.status === "failed") {
      run(
        "update posts set status = 'failed', external_id = ?, error = ?, error_code = 'platform_failed', next_attempt_at = null, locked_at = null, updated_at = ? where id = ?",
        nextId,
        (st.error ?? "The platform failed to process the video").slice(0, 1000),
        iso(now),
        post.id,
      );
      return "failed";
    }
    run(
      "update posts set status = 'processing', external_id = ?, next_attempt_at = ?, locked_at = null, updated_at = ? where id = ?",
      nextId,
      iso(now.getTime() + POLL_DELAY_MS),
      iso(now),
      post.id,
    );
    return "processing";
  } catch (e) {
    return handleError(post, account, e, "poll", now, deps);
  }
}

function failPost(post: Post, code: string, message: string, now: Date): Outcome {
  run(
    "update posts set status = 'failed', error = ?, error_code = ?, next_attempt_at = null, locked_at = null, updated_at = ? where id = ?",
    message.slice(0, 1000),
    code,
    iso(now),
    post.id,
  );
  return "failed";
}

function handleError(post: Post, account: SocialAccount, e: unknown, mode: "publish" | "poll", now: Date, deps: EngineDeps): Outcome {
  const nowS = iso(now);
  if (!isPublishError(e)) {
    const msg = e instanceof Error ? e.message : String(e);
    if (mode === "poll") return rescheduleOrFail(post, "status_check_failed", msg, undefined, now, deps, true);
    // Unknown failure around an upload: the outcome is uncertain, do not auto-retry (could duplicate).
    run("update posts set status = 'failed', error = ?, error_code = 'unexpected_error', next_attempt_at = null, locked_at = null, updated_at = ? where id = ?", msg.slice(0, 1000), nowS, post.id);
    return "failed";
  }
  if (e.needsReconnect) {
    markNeedsReconnect(account.id, e.message);
    run(
      "update posts set status = 'failed', error = ?, error_code = 'needs_reconnect', next_attempt_at = null, locked_at = null, updated_at = ? where id = ?",
      e.message.slice(0, 1000),
      nowS,
      post.id,
    );
    return "failed";
  }
  if (e.retryable) return rescheduleOrFail(post, e.code, e.message, e, now, deps, mode === "poll");
  run(
    "update posts set status = 'failed', error = ?, error_code = ?, next_attempt_at = null, locked_at = null, updated_at = ? where id = ?",
    e.message.slice(0, 1000),
    mode === "poll" ? "status_check_failed" : e.code,
    nowS,
    post.id,
  );
  return "failed";
}

/** Retryable problem: independent exponential backoff for THIS post. */
function rescheduleOrFail(post: Post, code: string, message: string, err: PublishError | undefined, now: Date, deps: EngineDeps, poll: boolean): Outcome {
  const nowS = iso(now);
  const fresh = getPost(post.id) ?? post;
  const attempts = fresh.attempts;
  if (!poll && attempts >= fresh.max_attempts) {
    run(
      "update posts set status = 'failed', error = ?, error_code = ?, next_attempt_at = null, locked_at = null, updated_at = ? where id = ?",
      `${message} (gave up after ${attempts} attempts)`.slice(0, 1000),
      code,
      nowS,
      post.id,
    );
    return "failed";
  }
  const base = backoffDelayMs(Math.max(1, attempts), deps.backoff ?? DEFAULT_BACKOFF);
  const delay = Math.max(base, (err?.retryAfterSec ?? 0) * 1000);
  run(
    `update posts set status = ?, error = ?, error_code = ?, next_attempt_at = ?, locked_at = null, updated_at = ? where id = ?`,
    poll ? "processing" : "queued",
    message.slice(0, 1000),
    code,
    iso(now.getTime() + delay),
    nowS,
    post.id,
  );
  return "retry";
}

