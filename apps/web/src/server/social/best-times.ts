import { PROVIDERS, type Provider } from "@klipz/shared";
import { all } from "../db";

/**
 * Best-time suggestions. Two bases:
 *  - "history": the user's own data. Needs >= MIN_HISTORY published posts for that provider that have a
 *    metrics snapshot; posts are bucketed by hour-of-week (in the user's time zone), buckets are ranked
 *    by mean views of the latest snapshot.
 *  - "default": general-purpose slots per platform (commonly cited engagement windows from public
 *    social-media studies; they are heuristics, not guarantees, and vary by audience). Local time, 24 h.
 */
export const MIN_HISTORY = 5;

// [weekday 0=Sun..6=Sat, hour]
export const DEFAULT_SLOTS: Record<Provider, [number, number][]> = {
  youtube: [[4, 15], [5, 15], [6, 10], [0, 10], [2, 16]],
  tiktok: [[2, 19], [4, 19], [5, 17], [0, 20], [3, 12]],
  instagram: [[2, 11], [3, 11], [5, 12], [1, 19], [0, 18]],
  facebook: [[3, 11], [4, 13], [5, 9], [1, 12], [0, 14]],
  x: [[1, 9], [2, 9], [3, 12], [4, 9], [5, 11]],
  linkedin: [[2, 9], [3, 10], [4, 9], [1, 8], [2, 12]],
};

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

export function localParts(date: Date, tz: string): LocalParts {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { year: +o.year!, month: +o.month!, day: +o.day!, hour: +o.hour! % 24, minute: +o.minute!, second: +o.second!, weekday: WEEKDAYS[o.weekday!] ?? 0 };
}

const offsetMs = (utcMs: number, tz: string): number => {
  const p = localParts(new Date(utcMs), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
};

/** Local wall-clock time in `tz` -> UTC instant (ms). Returns undefined for times that do not exist (DST gap). */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number | undefined {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const off1 = offsetMs(guess, tz);
  let t = guess - off1;
  const off2 = offsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  const back = localParts(new Date(t), tz);
  return back.hour === h && back.minute === min && back.day === d ? t : undefined;
}

export interface Slot {
  at: string; // ISO UTC
  local: string; // YYYY-MM-DD HH:mm in the requested zone
  weekday: number;
  hour: number;
  reason: string;
}
export interface ProviderSuggestion {
  basis: "history" | "default";
  sampleSize: number;
  slots: Slot[];
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Next `count` future occurrences of the (weekday, hour) buckets, soonest first. */
export function nextSlots(buckets: { weekday: number; hour: number; reason: string }[], tz: string, now: Date, count = 3): Slot[] {
  const out: (Slot & { ms: number })[] = [];
  const startParts = localParts(now, tz);
  for (let add = 0; add <= 14; add++) {
    // Calendar day `add` days from today in tz (pure date arithmetic, DST-safe).
    const day = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day + add));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate(), wd = day.getUTCDay();
    for (const b of buckets) {
      if (b.weekday !== wd) continue;
      const ms = zonedToUtc(y, m, d, b.hour, 0, tz);
      if (ms === undefined || ms <= now.getTime() + 10 * 60_000) continue;
      out.push({ ms, at: new Date(ms).toISOString(), local: `${y}-${pad(m)}-${pad(d)} ${pad(b.hour)}:00`, weekday: wd, hour: b.hour, reason: b.reason });
    }
  }
  return out.sort((a, b) => a.ms - b.ms).slice(0, count).map(({ ms: _ms, ...s }) => s);
}

/** Hour-of-week buckets ranked by mean views. */
export function rankBuckets(samples: { publishedAt: string; views: number }[], tz: string): { weekday: number; hour: number; mean: number; n: number }[] {
  const acc = new Map<string, { weekday: number; hour: number; sum: number; n: number }>();
  for (const s of samples) {
    const p = localParts(new Date(s.publishedAt), tz);
    const key = `${p.weekday}-${p.hour}`;
    const cur = acc.get(key) ?? { weekday: p.weekday, hour: p.hour, sum: 0, n: 0 };
    cur.sum += s.views;
    cur.n++;
    acc.set(key, cur);
  }
  return [...acc.values()].map((b) => ({ weekday: b.weekday, hour: b.hour, mean: b.sum / b.n, n: b.n })).sort((a, b) => b.mean - a.mean || b.n - a.n);
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function suggestBestTimes(providers: Provider[], tz: string, now: Date = new Date()): Record<string, ProviderSuggestion> {
  const out: Record<string, ProviderSuggestion> = {};
  for (const provider of providers) {
    const samples = all<{ published_at: string; views: number }>(
      `select p.published_at, m.views from posts p
       join post_metrics m on m.id = (select id from post_metrics where post_id = p.id order by captured_on desc limit 1)
       where p.provider = ? and p.status = 'published' and p.published_at is not null and m.views is not null`,
      provider,
    ).map((r) => ({ publishedAt: r.published_at, views: r.views }));
    if (samples.length >= MIN_HISTORY) {
      const top = rankBuckets(samples, tz).slice(0, 5);
      const buckets = top.map((b) => ({ weekday: b.weekday, hour: b.hour, reason: `Your posts on ${DAY[b.weekday]} around ${pad(b.hour)}:00 averaged ${Math.round(b.mean)} views (${b.n} post${b.n === 1 ? "" : "s"})` }));
      const slots = nextSlots(buckets, tz, now, 3);
      if (slots.length) {
        out[provider] = { basis: "history", sampleSize: samples.length, slots };
        continue;
      }
    }
    const buckets = DEFAULT_SLOTS[provider].map(([weekday, hour]) => ({ weekday, hour, reason: `General ${provider} guidance: ${DAY[weekday]} around ${pad(hour)}:00 local time (not based on your data yet)` }));
    out[provider] = { basis: "default", sampleSize: samples.length, slots: nextSlots(buckets, tz, now, 3) };
  }
  return out;
}

export const parseProviders = (s: string | null): Provider[] => {
  const list = (s ?? "").split(",").map((x) => x.trim()).filter((x): x is Provider => (PROVIDERS as string[]).includes(x));
  return list.length ? list : [...PROVIDERS];
};
