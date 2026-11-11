import { PROVIDERS, type Provider } from "@klipz/shared";
import { all } from "../db";

export interface Totals {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  impressions: number;
}

const zero = (): Totals => ({ posts: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, impressions: 0 });

interface PostMetricRow {
  post_id: string;
  clip_id: string;
  clip_title: string | null;
  provider: Provider;
  external_url: string | null;
  published_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  impressions: number | null;
}

export interface ClipRow {
  clipId: string;
  title: string | null;
  totals: Totals;
  providers: Partial<Record<Provider, { posts: number; views: number; likes: number; comments: number; shares: number; url: string | null; postId: string }>>;
}

export interface Analytics {
  days: number;
  since: string;
  totals: Totals;
  byProvider: Partial<Record<Provider, Totals>>;
  clips: ClipRow[];
  /** Cumulative totals per day across published posts (each post's snapshot carried forward). */
  series: {
    date: string;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    viewsDelta: number;
    /** per platform: cumulative views and the gain since the previous snapshot day */
    byProvider: Partial<Record<Provider, { views: number; viewsDelta: number }>>;
  }[];
  lastCapturedOn: string | null;
}

function add(t: Totals, r: PostMetricRow): void {
  t.posts++;
  t.views += r.views ?? 0;
  t.likes += r.likes ?? 0;
  t.comments += r.comments ?? 0;
  t.shares += r.shares ?? 0;
  t.saves += r.saves ?? 0;
  t.impressions += r.impressions ?? 0;
}

/** Aggregate published posts (last `days` days) using each post's LATEST metrics snapshot. */
export function analytics(days = 30, now: Date = new Date()): Analytics {
  const d = Math.max(1, Math.min(Math.floor(days) || 30, 365));
  const since = new Date(now.getTime() - d * 86400_000).toISOString();
  const rows = all<PostMetricRow>(
    `select p.id as post_id, p.clip_id, c.title as clip_title, p.provider, p.external_url, p.published_at,
            m.views, m.likes, m.comments, m.shares, m.saves, m.impressions
     from posts p
     left join clips c on c.id = p.clip_id
     left join post_metrics m on m.id = (select id from post_metrics where post_id = p.id order by captured_on desc limit 1)
     where p.status = 'published' and p.published_at >= ?
     order by p.published_at desc`,
    since,
  );
  const totals = zero();
  const byProvider: Partial<Record<Provider, Totals>> = {};
  const clipMap = new Map<string, ClipRow>();
  for (const r of rows) {
    add(totals, r);
    add((byProvider[r.provider] ??= zero()), r);
    let clip = clipMap.get(r.clip_id);
    if (!clip) clipMap.set(r.clip_id, (clip = { clipId: r.clip_id, title: r.clip_title, totals: zero(), providers: {} }));
    add(clip.totals, r);
    const slot = (clip.providers[r.provider] ??= { posts: 0, views: 0, likes: 0, comments: 0, shares: 0, url: r.external_url, postId: r.post_id });
    slot.posts++;
    slot.views += r.views ?? 0;
    slot.likes += r.likes ?? 0;
    slot.comments += r.comments ?? 0;
    slot.shares += r.shares ?? 0;
  }
  const clips = [...clipMap.values()].sort((a, b) => b.totals.views - a.totals.views);
  for (const p of PROVIDERS) if (!byProvider[p] && rows.some((r) => r.provider === p)) byProvider[p] = zero();

  // Daily series from snapshots, carried forward per post.
  const snaps = all<{ post_id: string; provider: Provider; captured_on: string; views: number | null; likes: number | null; comments: number | null; shares: number | null }>(
    `select m.post_id, p.provider, m.captured_on, m.views, m.likes, m.comments, m.shares from post_metrics m
     join posts p on p.id = m.post_id where p.status = 'published' and p.published_at >= ? order by m.captured_on`,
    since,
  );
  const dates = [...new Set(snaps.map((s) => s.captured_on))].sort();
  const perPost = new Map<string, typeof snaps>();
  for (const s of snaps) (perPost.get(s.post_id) ?? perPost.set(s.post_id, []).get(s.post_id)!).push(s);
  const series: Analytics["series"] = [];
  let prev = 0;
  const prevByProvider: Partial<Record<Provider, number>> = {};
  for (const date of dates) {
    let views = 0, likes = 0, comments = 0, shares = 0;
    const perProvider: Partial<Record<Provider, number>> = {};
    for (const list of perPost.values()) {
      let last: (typeof snaps)[number] | undefined;
      for (const s of list) if (s.captured_on <= date) last = s;
      if (last) {
        views += last.views ?? 0;
        perProvider[last.provider] = (perProvider[last.provider] ?? 0) + (last.views ?? 0);
        likes += last.likes ?? 0;
        comments += last.comments ?? 0;
        shares += last.shares ?? 0;
      }
    }
    const byProv: Analytics["series"][number]["byProvider"] = {};
    for (const [k, v] of Object.entries(perProvider) as [Provider, number][]) {
      byProv[k] = { views: v, viewsDelta: v - (prevByProvider[k] ?? 0) };
      prevByProvider[k] = v;
    }
    series.push({ date, views, likes, comments, shares, viewsDelta: views - prev, byProvider: byProv });
    prev = views;
  }
  return { days: d, since, totals, byProvider, clips, series, lastCapturedOn: dates.at(-1) ?? null };
}
