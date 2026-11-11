import fs from "node:fs";
import { z } from "zod";
import type { Clip, Post, Provider, Render, SocialAccount } from "@klipz/shared";
import { PROVIDERS } from "@klipz/shared";
import {
  PLATFORM_LIMITS,
  captionLength,
  composeCaption,
  composeTitle,
  type PostMeta,
  type Publisher,
  type RenderAsset,
  type ValidationIssue,
} from "@klipz/publishers";
import { all, get, newId, nowIso, run, tx } from "../db";
import { HttpError } from "../http";
import { renderAssetOf } from "../renders";
import { getAccount, getClip, getPost, getRender } from "../repo";
import { accountInfoOf } from "./accounts";
import { getPublisherFor } from "./publishers";

const providerEnum = z.enum(PROVIDERS as [Provider, ...Provider[]]);
const optionsRecord = z.record(z.string(), z.unknown());

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const PostInputSchema = z.object({
  clipId: z.string().min(1),
  renderId: z.string().min(1),
  accountIds: z.array(z.string().min(1)).min(1).max(24),
  caption: z.string().max(20000).default(""),
  hashtags: z.array(z.string().max(100)).max(100).default([]),
  title: z.string().max(300).optional(),
  coverTimestampMs: z.number().int().min(0).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA time zone").optional(),
  overrides: z
    .record(
      z.string(),
      z.object({
        caption: z.string().max(20000).optional(),
        hashtags: z.array(z.string().max(100)).max(100).optional(),
        title: z.string().max(300).optional(),
        options: optionsRecord.optional(),
      }),
    )
    .optional(),
  options: z.record(providerEnum, optionsRecord).optional(),
});
export type PostInput = z.infer<typeof PostInputSchema>;

export interface ComposedPreview {
  caption: string;
  title?: string;
  length: number;
  limit: number;
}

export interface PlanItem {
  account: SocialAccount;
  meta: PostMeta;
  issues: ValidationIssue[];
  composed: ComposedPreview;
}

export interface PostPlan {
  clip: Clip;
  render: Render;
  asset: RenderAsset;
  items: PlanItem[];
}

export interface PlanDeps {
  publisherFor?: (provider: Provider) => Publisher;
}

/** Compose what each platform would receive and run each adapter's validator. No writes. */
export function planPosts(input: PostInput, deps: PlanDeps = {}): PostPlan {
  const publisherFor = deps.publisherFor ?? ((p: Provider) => getPublisherFor(p));
  const clip = getClip(input.clipId) ?? failWith(404, "Clip not found");
  const render = getRender(input.renderId) ?? failWith(404, "Render not found");
  if (render.clip_id !== clip.id) throw new HttpError(400, "Render does not belong to this clip");
  if (render.status !== "ready") throw new HttpError(400, "Render is not ready yet");
  const asset = renderAssetOf(render);
  if (!asset) throw new HttpError(400, "Render has no video file");

  const fileMissing = !(asset.filePath && fs.existsSync(asset.filePath));
  const items: PlanItem[] = [];
  const seen = new Set<string>();
  for (const accountId of input.accountIds) {
    if (seen.has(accountId)) continue;
    seen.add(accountId);
    const account = getAccount(accountId) ?? failWith(400, `Unknown account ${accountId}`);
    const ov = input.overrides?.[accountId];
    const meta: PostMeta = {
      caption: ov?.caption ?? input.caption,
      hashtags: ov?.hashtags ?? input.hashtags,
      options: { ...(input.options?.[account.provider] ?? {}), ...(ov?.options ?? {}) },
    };
    const title = ov?.title ?? input.title;
    if (title !== undefined && title !== "") meta.title = title;
    if (input.coverTimestampMs !== undefined) meta.coverTimestampMs = input.coverTimestampMs;

    const publisher = publisherFor(account.provider);
    const issues = [...publisher.validate(asset, meta, accountInfoOf(account))];
    if (fileMissing) issues.push({ field: "render", code: "file_missing", message: "The rendered video file is missing on disk. Re-render the clip.", severity: "error" });
    if (account.status !== "active") {
      issues.push({ field: "account", code: "needs_reconnect", message: `${account.display_name} needs to be reconnected before posting.`, severity: "error" });
    }
    items.push({ account, meta, issues, composed: composePreview(account.provider, meta) });
  }
  return { clip, render, asset, items };
}

function failWith(status: number, msg: string): never {
  throw new HttpError(status, msg);
}

export function composePreview(provider: Provider, meta: PostMeta): ComposedPreview {
  const caption = composeCaption(provider, meta);
  const out: ComposedPreview = { caption, length: captionLength(provider, caption), limit: PLATFORM_LIMITS[provider].captionMax };
  if (provider === "youtube" || provider === "facebook" || provider === "linkedin") out.title = composeTitle(provider, meta, { appendShorts: provider === "youtube" });
  return out;
}

export function issuesByAccount(plan: PostPlan): Record<string, ValidationIssue[]> {
  const out: Record<string, ValidationIssue[]> = {};
  for (const it of plan.items) out[it.account.id] = it.issues;
  return out;
}

export const hasBlocking = (plan: PostPlan): boolean => plan.items.some((i) => i.issues.some((x) => x.severity === "error"));

/** POST /api/posts/validate */
export function validatePosts(input: PostInput, deps: PlanDeps = {}) {
  const plan = planPosts(input, deps);
  return {
    issues: issuesByAccount(plan),
    composed: Object.fromEntries(plan.items.map((i) => [i.account.id, i.composed])),
  };
}

export class ValidationFailed extends Error {
  constructor(public issues: Record<string, ValidationIssue[]>) {
    super("Validation failed");
  }
}

/** Fan one composer submit out to one post row per account. Throws ValidationFailed (nothing written) on any error issue. */
export function createPosts(input: PostInput, now: Date = new Date(), deps: PlanDeps = {}): { batchId: string; posts: Post[] } {
  const plan = planPosts(input, deps);
  if (hasBlocking(plan)) throw new ValidationFailed(issuesByAccount(plan));
  const batchId = newId();
  const when = input.scheduledAt ? new Date(input.scheduledAt) : undefined;
  const future = when !== undefined && when.getTime() > now.getTime();
  const nowStr = now.toISOString();
  const ids: string[] = [];
  tx(() => {
    for (const it of plan.items) {
      const id = newId();
      ids.push(id);
      const ov = input.overrides?.[it.account.id];
      run(
        `insert into posts (id, batch_id, clip_id, render_id, social_account_id, provider, caption, hashtags, title, options,
           cover_timestamp_ms, scheduled_at, timezone, status, next_attempt_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        batchId,
        plan.clip.id,
        plan.render.id,
        it.account.id,
        it.account.provider,
        it.meta.caption,
        JSON.stringify(it.meta.hashtags),
        it.meta.title ?? ov?.title ?? null,
        JSON.stringify(it.meta.options),
        it.meta.coverTimestampMs ?? null,
        future && when ? when.toISOString() : null,
        input.timezone ?? null,
        future ? "scheduled" : "queued",
        future ? null : nowStr,
      );
    }
  });
  return { batchId, posts: ids.map((id) => getPost(id)!) };
}

// ── listing ─────────────────────────────────────────────────────────────

export interface PostView extends Post {
  account: { id: string | null; display_name: string | null; username: string | null; avatar_url: string | null; status: string | null } | null;
  clip_title: string | null;
  cover_key: string | null;
  metrics: { views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; captured_on: string } | null;
}

const VIEW_SQL = `
  select p.*, a.display_name as a_name, a.username as a_user, a.avatar_url as a_avatar, a.status as a_status,
         c.title as clip_title, r.cover_key as cover_key,
         m.views as m_views, m.likes as m_likes, m.comments as m_comments, m.shares as m_shares, m.saves as m_saves, m.captured_on as m_on
  from posts p
  left join social_accounts a on a.id = p.social_account_id
  left join clips c on c.id = p.clip_id
  left join renders r on r.id = p.render_id
  left join post_metrics m on m.id = (select id from post_metrics where post_id = p.id order by captured_on desc limit 1)`;

function toView(r: Record<string, unknown>): PostView {
  const v = { ...r } as Record<string, unknown>;
  for (const k of ["hashtags", "options"]) if (typeof v[k] === "string") v[k] = safeParse(v[k] as string);
  const account = v.social_account_id
    ? { id: v.social_account_id as string, display_name: v.a_name as string | null, username: v.a_user as string | null, avatar_url: v.a_avatar as string | null, status: v.a_status as string | null }
    : null;
  const metrics = v.m_on
    ? { views: v.m_views as number | null, likes: v.m_likes as number | null, comments: v.m_comments as number | null, shares: v.m_shares as number | null, saves: v.m_saves as number | null, captured_on: v.m_on as string }
    : null;
  for (const k of ["a_name", "a_user", "a_avatar", "a_status", "m_views", "m_likes", "m_comments", "m_shares", "m_saves", "m_on", "locked_at"]) delete v[k];
  return { ...(v as unknown as Post), account, clip_title: (v.clip_title as string | null) ?? null, cover_key: (v.cover_key as string | null) ?? null, metrics };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function listPostViews(f: { clipId?: string; batchId?: string; status?: string } = {}, limit = 500): PostView[] {
  const where: string[] = [];
  const params: string[] = [];
  if (f.clipId) (where.push("p.clip_id = ?"), params.push(f.clipId));
  if (f.batchId) (where.push("p.batch_id = ?"), params.push(f.batchId));
  if (f.status) {
    const statuses = f.status.split(",").map((s) => s.trim()).filter(Boolean);
    where.push(`p.status in (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  const sql = `${VIEW_SQL} ${where.length ? "where " + where.join(" and ") : ""} order by p.created_at desc, p.provider limit ${Math.max(1, Math.min(limit, 1000))}`;
  return all(sql, ...params).map(toView);
}

export function getPostView(id: string): PostView | undefined {
  const r = get(`${VIEW_SQL} where p.id = ?`, id);
  return r ? toView(r) : undefined;
}

// ── actions ─────────────────────────────────────────────────────────────

export const PostActionSchema = z.discriminatedUnion("action", [
  /** `caption` (optional) replaces the stored caption before re-queueing, so a post rejected for its text can be fixed. */
  z.object({ action: z.literal("retry"), caption: z.string().max(20000).optional() }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("reschedule"), scheduledAt: z.string().datetime({ offset: true }) }),
]);
export type PostAction = z.infer<typeof PostActionSchema>;

export function applyPostAction(id: string, a: PostAction, now: Date = new Date()): Post {
  const post = getPost(id) ?? failWith(404, "Post not found");
  const t = nowIso();
  if (a.action === "cancel") {
    const r = run("update posts set status = 'cancelled', next_attempt_at = null, locked_at = null, updated_at = ? where id = ? and status in ('scheduled','queued')", t, id);
    if (r.changes === 0) throw new HttpError(409, `Only scheduled or queued posts can be cancelled (this one is ${post.status})`);
  } else if (a.action === "reschedule") {
    if (post.status !== "scheduled") throw new HttpError(409, `Only scheduled posts can be rescheduled (this one is ${post.status})`);
    const when = new Date(a.scheduledAt);
    const r = run("update posts set scheduled_at = ?, updated_at = ? where id = ? and status = 'scheduled'", when.toISOString(), t, id);
    if (r.changes === 0) throw new HttpError(409, "Post is no longer scheduled");
  } else {
    if (post.status !== "failed") throw new HttpError(409, `Only failed posts can be retried (this one is ${post.status})`);
    const nowStr = now.toISOString();
    if (a.caption !== undefined) {
      if (post.external_id && post.error_code !== "platform_failed") throw new HttpError(409, "This post is already on the platform; its text can no longer be changed.");
      run("update posts set caption = ?, updated_at = ? where id = ? and status = 'failed'", a.caption, t, id);
    }
    let r: { changes: number };
    if (post.external_id) {
      // Already handed to the platform. Re-publishing could create a duplicate, so only re-poll when that is safe.
      if (post.error_code === "platform_failed") {
        r = run(
          `update posts set status = 'queued', attempts = 0, external_id = null, external_url = null, error = null, error_code = null,
             next_attempt_at = ?, locked_at = null, updated_at = ? where id = ? and status = 'failed'`,
          nowStr,
          t,
          id,
        );
      } else if (post.error_code === "needs_reconnect" || post.error_code === "status_check_failed") {
        r = run("update posts set status = 'processing', error = null, error_code = null, next_attempt_at = ?, locked_at = null, updated_at = ? where id = ? and status = 'failed'", nowStr, t, id);
      } else {
        throw new HttpError(409, `This post was already sent to the platform (id ${post.external_id}). Check it there; delete this entry if it did not go through.`);
      }
    } else {
      r = run(
        `update posts set status = 'queued', attempts = 0, error = null, error_code = null, next_attempt_at = ?, locked_at = null,
           updated_at = ? where id = ? and status = 'failed'`,
        nowStr,
        t,
        id,
      );
    }
    if (r.changes === 0) throw new HttpError(409, "Post changed state, try again");
  }
  return getPost(id)!;
}

export function deletePost(id: string): void {
  const post = getPost(id) ?? failWith(404, "Post not found");
  if (!["draft", "scheduled", "queued", "failed", "cancelled"].includes(post.status)) {
    throw new HttpError(409, `A ${post.status} post cannot be deleted`);
  }
  const r = run("delete from posts where id = ? and status in ('draft','scheduled','queued','failed','cancelled')", id);
  if (r.changes === 0) throw new HttpError(409, "Post changed state, try again");
}

