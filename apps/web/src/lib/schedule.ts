// Pure date helpers for the composer: wall-clock time in an IANA zone <-> UTC.

/** Offset of `tz` from UTC at the instant `ms`, in minutes (east positive). */
export function tzOffsetMinutes(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function partsInZone(ms: number, tz: string): WallParts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== "literal") out[part.type] = Number(part.value);
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function parseLocal(local: string): WallParts | null {
  const m = LOCAL_RE.exec(local);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute, second: 0 };
}

export function formatLocalValue(p: WallParts): string {
  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${z(p.year, 4)}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

export interface Zoned {
  utc: Date;
  /** The wall time does not exist in that zone (spring-forward gap); the result is shifted to the next valid time. */
  inGap: boolean;
  /** The wall time happens twice (fall-back); the earlier occurrence was used. */
  ambiguous: boolean;
}

/** Convert a `datetime-local` value (wall clock in `tz`) to a UTC instant. Returns null for malformed input. */
export function zonedLocalToUtc(local: string, tz: string): Zoned | null {
  const w = parseLocal(local);
  if (!w) return null;
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const offBefore = tzOffsetMinutes(wall - 86400_000, tz);
  const offAfter = tzOffsetMinutes(wall + 86400_000, tz);
  const candidates = [...new Set([offBefore, offAfter])].map((off) => wall - off * 60000);
  const valid = candidates.filter((t) => formatLocalValue(partsInZone(t, tz)) === local).sort((a, b) => a - b);
  if (valid.length > 0) return { utc: new Date(valid[0]!), inGap: false, ambiguous: valid.length > 1 };
  // Gap: interpret with the offset in force before the transition (what Date/Temporal "compatible" does).
  return { utc: new Date(wall - offBefore * 60000), inGap: true, ambiguous: false };
}

export interface ScheduleCheck {
  ok: boolean;
  utc?: Date;
  error?: string;
  note?: string;
}

/** Validate a schedule: well-formed, a real zone, and at least `minLeadMs` in the future. */
export function checkSchedule(local: string, tz: string, now: Date, minLeadMs = 60_000): ScheduleCheck {
  if (!local) return { ok: false, error: "Pick a date and time." };
  if (!isValidTimeZone(tz)) return { ok: false, error: "Unknown time zone." };
  const z = zonedLocalToUtc(local, tz);
  if (!z) return { ok: false, error: "That date and time is not valid." };
  if (z.utc.getTime() < now.getTime() + minLeadMs) {
    return { ok: false, utc: z.utc, error: minLeadMs > 0 ? "That time is in the past (or less than a minute away). Pick a later time or post now." : "That time is in the past." };
  }
  const note = z.inGap ? "That wall-clock time does not exist on that day (clocks jump forward); it was moved to the next valid time." : z.ambiguous ? "That wall-clock time happens twice (clocks go back); the first one is used." : undefined;
  return { ok: true, utc: z.utc, ...(note ? { note } : {}) };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `datetime-local` value for "now + minutes" as seen in `tz`. */
export function localValueIn(tz: string, at: Date, addMinutes = 0): string {
  return formatLocalValue(partsInZone(at.getTime() + addMinutes * 60000, tz));
}

/** Format an instant in a zone: "Thu, 12 Nov 2026, 15:00 CET". */
export function formatInZone(d: Date | string, tz: string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "–";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function formatUtc(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "–" : date.toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC");
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function listTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  let zones: string[] = [];
  try {
    zones = intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  return zones;
}

/** "in 2m 05s" / "in 3h 12m" / "in 2d 4h" / "due now". Past times read "due now". */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${String(m % 60).padStart(2, "0")}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}
