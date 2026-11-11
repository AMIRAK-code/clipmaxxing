import type { PostStatus, Provider } from "@klipz/shared";

export interface ProviderMeta {
  label: string;
  /** Series colour used by every chart / dot so a platform looks the same everywhere. */
  color: string;
}

export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  youtube: { label: "YouTube", color: "#f87171" },
  tiktok: { label: "TikTok", color: "#2dd4bf" },
  instagram: { label: "Instagram", color: "#f472b6" },
  facebook: { label: "Facebook", color: "#60a5fa" },
  x: { label: "X", color: "#cbd5e1" },
  linkedin: { label: "LinkedIn", color: "#fbbf24" },
};

export const providerLabel = (p: string): string => (PROVIDER_META as Record<string, ProviderMeta | undefined>)[p]?.label ?? p;

// ── captions ────────────────────────────────────────────────────────────

/** "#a #b, c" -> ["a","b","c"] (no #, no duplicates, order kept). */
export function parseHashtags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const t = raw.replace(/^#+/, "").trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export const formatHashtags = (tags: string[]): string => tags.map((t) => `#${t.replace(/^#+/, "")}`).join(" ");

export interface TextFields {
  caption: string;
  hashtags: string[];
  title: string;
}
export type TextOverride = Partial<TextFields>;

/** What a platform will actually get: its override where one is set, otherwise the shared value. */
export function effectiveText(shared: TextFields, ov: TextOverride | undefined): TextFields {
  return {
    caption: ov?.caption !== undefined ? ov.caption : shared.caption,
    hashtags: ov?.hashtags !== undefined ? ov.hashtags : shared.hashtags,
    title: ov?.title !== undefined ? ov.title : shared.title,
  };
}

/** Drop override fields that equal the shared value (so editing the shared text keeps flowing through). */
export function pruneOverride(shared: TextFields, ov: TextOverride | undefined): TextOverride | undefined {
  if (!ov) return undefined;
  const out: TextOverride = {};
  if (ov.caption !== undefined && ov.caption !== shared.caption) out.caption = ov.caption;
  if (ov.hashtags !== undefined && formatHashtags(ov.hashtags) !== formatHashtags(shared.hashtags)) out.hashtags = ov.hashtags;
  if (ov.title !== undefined && ov.title !== shared.title) out.title = ov.title;
  return Object.keys(out).length ? out : undefined;
}

export type CounterTone = "ok" | "warn" | "over";
export function counterTone(length: number, limit: number): CounterTone {
  if (limit > 0 && length > limit) return "over";
  if (limit > 0 && length > limit * 0.9) return "warn";
  return "ok";
}

// ── post status ─────────────────────────────────────────────────────────

export const TERMINAL_STATUSES: readonly PostStatus[] = ["published", "failed", "cancelled"];
export const isTerminalPost = (s: PostStatus): boolean => TERMINAL_STATUSES.includes(s);

export interface BatchLike {
  status: PostStatus;
}

export interface BatchSummary {
  total: number;
  published: number;
  failed: number;
  scheduled: number;
  cancelled: number;
  /** queued + publishing + processing (+ draft) */
  active: number;
  done: boolean;
  text: string;
}

export function summarizeBatch(posts: BatchLike[]): BatchSummary {
  const c = { published: 0, failed: 0, scheduled: 0, cancelled: 0, active: 0 };
  for (const p of posts) {
    if (p.status === "published") c.published++;
    else if (p.status === "failed") c.failed++;
    else if (p.status === "scheduled") c.scheduled++;
    else if (p.status === "cancelled") c.cancelled++;
    else c.active++;
  }
  const parts = [`${c.published} of ${posts.length} published`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.scheduled) parts.push(`${c.scheduled} scheduled`);
  if (c.active) parts.push(`${c.active} in progress`);
  if (c.cancelled) parts.push(`${c.cancelled} cancelled`);
  return { total: posts.length, ...c, done: c.active === 0 && c.scheduled === 0, text: parts.join(" · ") };
}

export interface Batchable extends BatchLike {
  batch_id: string;
  created_at: string;
}

/** Group posts by batch, newest batch first (by the earliest created_at in the group). Order inside a batch is kept. */
export function groupBatches<T extends Batchable>(posts: T[]): { batchId: string; createdAt: string; posts: T[] }[] {
  const map = new Map<string, { batchId: string; createdAt: string; posts: T[] }>();
  for (const p of posts) {
    const g = map.get(p.batch_id);
    if (g) {
      g.posts.push(p);
      if (p.created_at < g.createdAt) g.createdAt = p.created_at;
    } else map.set(p.batch_id, { batchId: p.batch_id, createdAt: p.created_at, posts: [p] });
  }
  return [...map.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export const STATUS_LABEL: Record<PostStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  queued: "Queued",
  publishing: "Publishing",
  processing: "Processing",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
};
