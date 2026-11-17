/**
 * Manual AI Mode: read the clip plan a chat AI (Gemini) answered with.
 *
 * The prompt asks for {"clips": [{"title", "text_on_screen", "segments": [{"video"?, "start", "end"}]}]}
 * with times in seconds. People paste whatever came back, so this is forgiving about the wrapping
 * (```json fences, a sentence before or after, a bare array), key names (start_time, from, hook, cuts ...),
 * and times ("72.4", "1:12.4", "00:01:12,400"), and strict about what matters: every segment must point at
 * a real video and lie inside it.
 */

export interface PlanVideo {
  id: string;
  /** file name, as listed in the transcript */
  name: string;
  durationSec: number;
}

export interface PlanSegment {
  /** source_videos.id */
  source: string;
  start: number;
  end: number;
}

export interface PlanClip {
  title: string;
  hook: string;
  segments: PlanSegment[];
}

export interface ParsedPlan {
  clips: PlanClip[];
  /** things that were fixed or skipped, to show the person */
  warnings: string[];
}

export class PlanError extends Error {}

export const MAX_PLAN_CLIPS = 30;
const MAX_SEGMENTS = 60;

/** Seconds from a number or a time string: "72.4", "1:12.4", "01:12", "0:01:12.400", "00:01:12,400", "72.4s". */
export function parseTime(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/s(ec(onds?)?)?$/i, "").replace(",", ".").trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** The JSON value inside a pasted answer. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    // a sentence around the JSON: take the outermost object or array
    const starts = [body.indexOf("{"), body.indexOf("[")].filter((i) => i >= 0);
    if (!starts.length) throw new PlanError("No JSON found. Paste the whole answer from Gemini.");
    const start = Math.min(...starts);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch (e) {
      throw new PlanError(`That is not valid JSON (${e instanceof Error ? e.message : "parse error"}).`);
    }
  }
}

const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

const stem = (name: string) => name.toLowerCase().replace(/\.[a-z0-9]+$/, "").trim();

/** Which video a segment means: a number (1-based, as in the transcript), a file name, or "video_light_2". */
function resolveVideo(ref: unknown, videos: PlanVideo[]): PlanVideo | null {
  if (ref === undefined || ref === null || ref === "") return videos.length === 1 ? videos[0]! : null;
  if (typeof ref === "number") return videos[ref - 1] ?? null;
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return videos[Number(s) - 1] ?? null;
  const byName = videos.find((v) => stem(v.name) === stem(s) || v.id === s);
  if (byName) return byName;
  const n = /(\d+)\s*$/.exec(stem(s));
  if (n && /video|clip|light|source/i.test(s)) return videos[Number(n[1]) - 1] ?? null;
  return /^video[_ ]?light$/i.test(stem(s)) && videos.length === 1 ? videos[0]! : null;
}

export function parsePlan(text: string, videos: PlanVideo[]): ParsedPlan {
  if (!text.trim()) throw new PlanError("Paste the JSON from Gemini first.");
  if (!videos.length) throw new PlanError("This project has no video.");
  const root = extractJson(text);
  const list: unknown = Array.isArray(root)
    ? root
    : root && typeof root === "object"
      ? (pick(root as Record<string, unknown>, ["clips", "shorts", "videos", "results", "items"]) ??
        ("segments" in (root as object) || "start" in (root as object) ? [root] : undefined))
      : undefined;
  if (!Array.isArray(list) || list.length === 0) throw new PlanError('No clips in the JSON: expected {"clips": [ ... ]}.');

  const warnings: string[] = [];
  const clips: PlanClip[] = [];
  list.slice(0, MAX_PLAN_CLIPS).forEach((raw, ci) => {
    const n = ci + 1;
    if (!raw || typeof raw !== "object") {
      warnings.push(`Clip ${n} is not an object; skipped.`);
      return;
    }
    const c = raw as Record<string, unknown>;
    const title = String(pick(c, ["title", "name", "clip_title"]) ?? "").trim().slice(0, 120);
    const hook = String(pick(c, ["text_on_screen", "hook", "on_screen_text", "hook_text", "overlay", "caption"]) ?? "").trim().slice(0, 200);
    let segs = pick(c, ["segments", "cuts", "parts", "ranges", "timestamps"]);
    if (!Array.isArray(segs)) segs = pick(c, ["start", "start_time", "from"]) !== undefined ? [c] : [];
    const clipVideo = pick(c, ["video", "video_index", "source", "file", "video_file"]);
    const segments: PlanSegment[] = [];
    (segs as unknown[]).slice(0, MAX_SEGMENTS).forEach((rs, si) => {
      const where = `Clip ${n}, segment ${si + 1}`;
      if (!rs || typeof rs !== "object") return void warnings.push(`${where} is not an object; skipped.`);
      const s = rs as Record<string, unknown>;
      const start = parseTime(pick(s, ["start", "start_time", "startTime", "from", "begin", "start_sec", "s"]));
      const end = parseTime(pick(s, ["end", "end_time", "endTime", "to", "finish", "end_sec", "e"]));
      if (start === null || end === null) return void warnings.push(`${where} has no readable start / end; skipped.`);
      const video = resolveVideo(pick(s, ["video", "video_index", "source", "file", "video_file"]) ?? clipVideo, videos);
      if (!video) return void warnings.push(`${where}: which video? Add "video": 1 (the number in the transcript); skipped.`);
      if (end <= start) return void warnings.push(`${where} ends before it starts; skipped.`);
      if (video.durationSec > 0 && start >= video.durationSec) {
        return void warnings.push(`${where} starts after the end of ${video.name}; skipped.`);
      }
      const clamped = video.durationSec > 0 ? Math.min(end, video.durationSec) : end;
      if (clamped < end - 0.01) warnings.push(`${where} ran past the end of ${video.name}; shortened.`);
      segments.push({ source: video.id, start: Math.round(start * 1000) / 1000, end: Math.round(clamped * 1000) / 1000 });
    });
    if (!segments.length) return void warnings.push(`Clip ${n}${title ? ` (${title})` : ""} has no usable segment; skipped.`);
    clips.push({ title, hook, segments });
  });
  if (list.length > MAX_PLAN_CLIPS) warnings.push(`Only the first ${MAX_PLAN_CLIPS} clips are used.`);
  if (!clips.length) throw new PlanError(`No usable clips. ${warnings.slice(0, 3).join(" ")}`.trim());
  return { clips, warnings };
}
