import type { Clip, Job, ScoreBreakdown, SourceVideo } from "@klipz/shared";

export type ClipFilter = "all" | "kept" | "candidate";

export const clampScore = (v: number | null | undefined): number => (v == null || !Number.isFinite(v) ? 0 : Math.min(100, Math.max(0, Math.round(v))));

export type ScoreTone = "good" | "warn" | "bad";
export const scoreTone = (score: number | null | undefined): ScoreTone => {
  const s = clampScore(score);
  return s >= 75 ? "good" : s >= 50 ? "warn" : "bad";
};

export const scorerLabel = (b: ScoreBreakdown | null): string => {
  if (!b?.scorer) return "Unscored";
  if (/claude|anthropic/i.test(b.scorer)) return "Claude";
  if (/ollama/i.test(b.scorer)) return "Ollama";
  if (/heuristic/i.test(b.scorer)) return "Heuristic";
  return b.scorer;
};

export const BREAKDOWN_KEYS = ["hook", "context", "emotion", "payoff", "energy"] as const;

/** Clips best-first; ties keep source order. */
export const rankClips = (clips: Clip[]): Clip[] =>
  [...clips].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.start_sec - b.start_sec);

export function filterClips(ranked: Clip[], filter: ClipFilter): { visible: Clip[]; discarded: Clip[] } {
  const discarded = ranked.filter((c) => c.status === "discarded");
  const live = ranked.filter((c) => c.status !== "discarded");
  const visible = filter === "all" ? live : live.filter((c) => c.status === (filter === "kept" ? "kept" : "candidate"));
  return { visible, discarded };
}

const ACTIVE = new Set(["queued", "running"]);
const BAD = new Set(["failed", "dead"]);

/**
 * Jobs worth showing: active and failed ones (plus succeeded with showDone).
 * A failed job is hidden once a newer job of the same type is active or succeeded.
 */
export function visibleJobs(jobs: Job[], showDone = false): Job[] {
  const shown = jobs.filter((j) => ACTIVE.has(j.status) || BAD.has(j.status) || (showDone && j.status === "succeeded"));
  return shown.filter(
    (j) =>
      !BAD.has(j.status) ||
      !jobs.some((o) => o.id !== j.id && o.type === j.type && (ACTIVE.has(o.status) || o.status === "succeeded") && (ACTIVE.has(o.status) || o.created_at > j.created_at)),
  );
}

/** The newest job among the given types, or undefined. */
export function latestJob(jobs: Job[], types: string[]): Job | undefined {
  return jobs.filter((j) => types.includes(j.type)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
}

/** Why a primary action can't be used right now, or null when it can. */
export function actionBlockReason(source: SourceVideo | null, jobs: Job[], type: "analyze" | "autoclip"): string | null {
  if (!source) return "This project has no source video.";
  if (source.status === "deleted") return "The source file was cleaned up. Import it again first.";
  if (source.status === "failed") return "The import failed. Fix that first.";
  if (source.status !== "ready") return "Waiting for the video to finish importing.";
  if (jobs.some((j) => j.type === type && ACTIVE.has(j.status))) return type === "analyze" ? "Already finding clips." : "AutoClip is already running.";
  return null;
}

export const fmtSec = (s: number): string => `${s.toFixed(1)} s`;
