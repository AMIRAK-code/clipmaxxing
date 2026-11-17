import type { Clip, EditState, Job, MontageScene, MontageSettings, Project, Render, SourceVideo, Word } from "@klipz/shared";
import { MONTAGE_DEFAULTS, MONTAGE_LIMITS } from "@klipz/shared";
import { all, get, newId, nowIso, row, rows, run, tx } from "./db";
import { HttpError } from "./http";
import { enqueueJob, jobsForProject } from "./jobs";
import { createRender, latestRenderByClip } from "./renders";
import { getTranscript } from "./repo";

/**
 * Montage projects: several uploads -> short mixes of their best scenes. The worker (steps/montage.py)
 * finds the scenes and builds the pool video and the first montages; "New mix" and "Make more" re-run
 * only the assembly, here, instantly. assembleMontages() is the same as the worker's (same generator,
 * same result for the same seed; apps/worker/tests/fixtures/montage_assembly.json checks both).
 */

// ── assembly (same as apps/worker/klipz_worker/steps/montage.py) ──────────
export const MIN_TRIMMED = 1.0;

/** mulberry32: small, fast, and exactly reproducible in Python. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (x: number) => Math.floor(x * 1000 + 0.5) / 1000;

export interface AssemblyScene {
  id: string;
  input: string;
  start: number;
  end: number;
  score: number;
}

export interface AssemblyPiece {
  sceneId: string;
  srcStart: number;
  srcEnd: number;
}

/**
 * Pieces for `count` montages: scenes picked at random (weighted by score), never two of the same upload
 * in a row when there is a choice, spreading scenes over the montages (`usage`: times each scene is
 * already used), until each montage is between minSec and maxSec long (never longer).
 */
export function assembleMontages(
  scenes: AssemblyScene[],
  count: number,
  minSec: number,
  maxSec: number,
  seed: number,
  usage: Record<string, number> = {},
): AssemblyPiece[][] {
  const rng = mulberry32(seed);
  const use: Record<string, number> = { ...usage };
  const out: AssemblyPiece[][] = [];
  for (let k = 0; k < Math.max(0, count); k++) {
    const target = minSec + rng() * (maxSec - minSec);
    const picks: AssemblyPiece[] = [];
    const chosen = new Set<string>();
    let total = 0;
    let last: string | null = null;
    while (total < target - 0.05) {
      const left = scenes.filter((s) => !chosen.has(s.id));
      if (left.length === 0) break;
      const room = maxSec - total;
      const fits = left.filter((s) => s.end - s.start <= room + 1e-6);
      if (fits.length === 0 && room < MIN_TRIMMED) break;
      const pool = fits.length ? fits : left;
      const variedRaw = pool.filter((s) => s.input !== last);
      const varied = variedRaw.length ? variedRaw : pool;
      const least = Math.min(...varied.map((s) => use[s.id] ?? 0));
      const cands = varied.filter((s) => (use[s.id] ?? 0) === least);
      const weights = cands.map((s) => Math.max(1, s.score || 0));
      let r = rng() * weights.reduce((a, b) => a + b, 0);
      let pick = cands[cands.length - 1]!;
      for (let i = 0; i < cands.length; i++) {
        r -= weights[i]!;
        if (r < 0) {
          pick = cands[i]!;
          break;
        }
      }
      let end = pick.end;
      if (end - pick.start > room) end = pick.start + room; // nothing fits the room left: end this scene early
      picks.push({ sceneId: pick.id, srcStart: r3(pick.start), srcEnd: r3(end) });
      chosen.add(pick.id);
      use[pick.id] = (use[pick.id] ?? 0) + 1;
      total += end - pick.start;
      last = pick.input;
    }
    out.push(picks);
  }
  return out;
}

/** EditState of a montage (montage.py montage_edit): captions off but ready, hook off with a suggestion. */
export function montageEdit(pieces: AssemblyPiece[], words: Word[], hook = ""): EditState {
  const video = pieces.map((p, i) => ({ id: `v${i}_${Math.round(p.srcStart * 1000)}`, srcStart: p.srcStart, srcEnd: p.srcEnd }));
  return {
    version: 1,
    video,
    captions: { enabled: false, styleId: "bold-outline", overrides: {}, words: captionWordsFor(pieces, words) },
    broll: [],
    audio: [],
    texts: [],
    zooms: [],
    look: "none",
    hook: { enabled: false, text: hook, durationSec: 2.5 },
    progressBar: { enabled: false, color: "#FFE600", position: "bottom", height: 10 },
    volume: 1,
    duckLevel: 0.25,
    safeZone: "tiktok",
  };
}

/** Caption words (pool times) of the words inside these pieces; ids as the worker makes them. */
export function captionWordsFor(pieces: { srcStart: number; srcEnd: number }[], words: Word[]): EditState["captions"]["words"] {
  const out: EditState["captions"]["words"] = [];
  words.forEach((w, i) => {
    const mid = (w.s + w.e) / 2;
    if (pieces.some((p) => p.srcStart <= mid && mid < p.srcEnd)) out.push({ id: `w${i}_${Math.round(w.s * 1000)}`, w: w.w.trim(), s: w.s, e: w.e });
  });
  return out;
}

export function normalizeSettings(s: Partial<MontageSettings> | null | undefined): MontageSettings {
  const v = { ...MONTAGE_DEFAULTS, ...(s ?? {}) };
  const [cLo, cHi] = MONTAGE_LIMITS.count;
  const [sLo, sHi] = MONTAGE_LIMITS.sec;
  const count = Math.round(Math.min(cHi, Math.max(cLo, Number(v.count) || MONTAGE_DEFAULTS.count)));
  let minSec = Math.min(sHi, Math.max(sLo, Number(v.minSec) || MONTAGE_DEFAULTS.minSec));
  let maxSec = Math.min(sHi, Math.max(sLo, Number(v.maxSec) || MONTAGE_DEFAULTS.maxSec));
  if (maxSec < minSec) [minSec, maxSec] = [maxSec, minSec];
  return { count, minSec, maxSec, ...(v.seed != null ? { seed: v.seed } : {}) };
}

const randomSeed = () => 1 + Math.floor(Math.random() * 2_147_483_000);

// ── projects ──────────────────────────────────────────────────────────────
export interface MontageProjectSummary extends Project {
  inputs: number;
  pool: SourceVideo | null;
  montage_count: number;
  job: Job | null;
}

export const getMontageProject = (id: string) =>
  row<Project>("projects", "select * from projects where id = ? and kind = 'montage'", id);

export function createMontageProject(title: string, settings: Partial<MontageSettings>): Project {
  const id = newId();
  run("insert into projects (id, title, kind, settings) values (?, ?, 'montage', ?)", id, title.slice(0, 160) || "Montage", JSON.stringify(normalizeSettings(settings)));
  return getMontageProject(id)!;
}

export function listMontageProjects(): MontageProjectSummary[] {
  return rows<Project>("projects", "select * from projects where kind = 'montage' order by created_at desc").map((p) => {
    const counts = get<{ inputs: number; montages: number }>(
      `select (select count(*) from source_videos where project_id = ? and role = 'input' and status != 'deleted') as inputs,
              (select count(*) from clips where project_id = ?) as montages`,
      p.id,
      p.id,
    );
    return {
      ...p,
      inputs: counts?.inputs ?? 0,
      montage_count: counts?.montages ?? 0,
      pool: poolOf(p.id),
      job: rows<Job>("jobs", "select * from jobs where project_id = ? and type = 'montage' order by created_at desc limit 1", p.id)[0] ?? null,
    };
  });
}

const poolOf = (projectId: string) =>
  row<SourceVideo>("source_videos", "select * from source_videos where project_id = ? and role = 'pool' and status = 'ready' order by created_at desc limit 1", projectId) ??
  null;

export const scenesForProject = (projectId: string) =>
  rows<MontageScene>("montage_scenes", "select * from montage_scenes where project_id = ? order by idx", projectId);

export interface MontageDetail {
  project: Project;
  inputs: SourceVideo[];
  pool: SourceVideo | null;
  scenes: MontageScene[];
  montages: Clip[];
  renders: Record<string, Render>;
  jobs: Job[];
}

export function montageDetail(projectId: string): MontageDetail {
  const project = getMontageProject(projectId);
  if (!project) throw new HttpError(404, "Montage not found");
  return {
    project,
    inputs: rows<SourceVideo>("source_videos", "select * from source_videos where project_id = ? and role = 'input' order by created_at", projectId),
    pool: poolOf(projectId),
    scenes: scenesForProject(projectId),
    // newest first: "Make more" adds at the top
    montages: rows<Clip>("clips", "select * from clips where project_id = ? order by created_at desc, title desc", projectId),
    renders: latestRenderByClip(projectId),
    jobs: jobsForProject(projectId, 20),
  };
}

export function updateMontageSettings(projectId: string, patch: Partial<MontageSettings>): Project {
  const p = getMontageProject(projectId);
  if (!p) throw new HttpError(404, "Montage not found");
  run("update projects set settings = ?, updated_at = ? where id = ?", JSON.stringify(normalizeSettings({ ...(p.settings ?? {}), ...patch })), nowIso(), projectId);
  return getMontageProject(projectId)!;
}

/** Queue the montage job once the uploads are in. */
export function startMontage(projectId: string): Job {
  const p = getMontageProject(projectId);
  if (!p) throw new HttpError(404, "Montage not found");
  const inputs = all<{ status: string }>("select status from source_videos where project_id = ? and role = 'input' and status != 'deleted'", projectId);
  if (inputs.length === 0) throw new HttpError(409, "Add at least one video first");
  if (inputs.some((s) => s.status === "uploading")) throw new HttpError(409, "Wait until every upload has finished");
  return enqueueJob("montage", { project_id: projectId }, { projectId, dedupeKey: `montage:${projectId}` });
}

// ── more montages / a new mix, from the pool the worker built ────────────
function poolContext(projectId: string) {
  const scenes = scenesForProject(projectId);
  if (scenes.length === 0) throw new HttpError(409, "The scenes are not ready yet");
  const poolId = scenes[0]!.pool_source_id;
  const words = getTranscript(poolId)?.words ?? [];
  const asm: AssemblyScene[] = scenes.map((s) => ({ id: s.id, input: s.input_source_id ?? "", start: s.pool_start, end: s.pool_end, score: s.score }));
  return { scenes, poolId, words, asm };
}

/** Times each scene is used by the project's montages (except `skipClipId`). */
function usageOf(projectId: string, scenes: MontageScene[], skipClipId?: string): Record<string, number> {
  const use: Record<string, number> = {};
  for (const c of rows<Clip>("clips", "select * from clips where project_id = ?", projectId)) {
    if (c.id === skipClipId) continue;
    for (const p of c.edit_state?.video ?? []) {
      const s = scenes.find((x) => x.pool_start - 0.01 <= p.srcStart && p.srcStart < x.pool_max);
      if (s) use[s.id] = (use[s.id] ?? 0) + 1;
    }
  }
  return use;
}

/** A short on-screen line from what is said in the montage's scenes. */
function hookFor(pieces: AssemblyPiece[], scenes: MontageScene[]): string {
  const said = pieces.map((p) => scenes.find((s) => s.id === p.sceneId)).find((s) => s?.has_speech && s.text);
  const text = (said?.text ?? "").trim();
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).trim()}…`;
}

/** Add `count` montages from the project's pool, each with a queued render. */
export function makeMoreMontages(projectId: string, count: number): Clip[] {
  const p = getMontageProject(projectId);
  if (!p) throw new HttpError(404, "Montage not found");
  const settings = normalizeSettings(p.settings);
  const n = Math.round(Math.min(MONTAGE_LIMITS.count[1], Math.max(1, count)));
  const { scenes, poolId, words, asm } = poolContext(projectId);
  const pool = row<SourceVideo>("source_videos", "select * from source_videos where id = ?", poolId);
  const plan = assembleMontages(asm, n, settings.minSec, settings.maxSec, randomSeed(), usageOf(projectId, scenes));
  const existing = get<{ n: number }>("select count(*) as n from clips where project_id = ?", projectId)?.n ?? 0;
  const ids = tx(() =>
    plan
      .filter((pieces) => pieces.length > 0)
      .map((pieces, k) => {
        const id = newId();
        const hook = hookFor(pieces, scenes);
        const used = pieces.map((x) => scenes.find((s) => s.id === x.sceneId)!);
        run(
          `insert into clips (id, project_id, source_video_id, start_sec, end_sec, score, score_breakdown, title, hook, status,
             caption_style_id, crop_track, edit_state) values (?, ?, ?, 0, ?, ?, ?, ?, ?, 'kept', 'bold-outline', ?, ?)`,
          id,
          projectId,
          poolId,
          Math.max(0.1, pool?.duration_sec ?? 0.1),
          Math.round((used.reduce((a, s) => a + s.score, 0) / used.length) * 100) / 100,
          JSON.stringify({ montage: true, scenes: pieces.map((x) => x.sceneId) }),
          `Montage ${existing + k + 1}`,
          hook || null,
          JSON.stringify(fullFrameTrack(pool?.duration_sec ?? 0)),
          JSON.stringify(montageEdit(pieces, words, hook)),
        );
        return id;
      }),
  );
  for (const id of ids) createRender(id);
  return ids.map((id) => row<Clip>("clips", "select * from clips where id = ?", id)!);
}

/** Give one montage a new random set of scenes (keeping its captions, hook, style and volume). */
export function remixMontage(clipId: string): Clip {
  const clip = row<Clip>("clips", "select * from clips where id = ?", clipId);
  if (!clip) throw new HttpError(404, "Montage not found");
  const p = getMontageProject(clip.project_id);
  if (!p) throw new HttpError(400, "Not a montage");
  const settings = normalizeSettings(p.settings);
  const { scenes, words, asm } = poolContext(p.id);
  const [pieces] = assembleMontages(asm, 1, settings.minSec, settings.maxSec, randomSeed(), usageOf(p.id, scenes, clipId));
  if (!pieces?.length) throw new HttpError(409, "No scenes to mix");
  const base = clip.edit_state ?? montageEdit(pieces, words, clip.hook ?? "");
  const fresh = montageEdit(pieces, words, base.hook.text);
  const edit: EditState = { ...base, video: fresh.video, captions: { ...base.captions, words: fresh.captions.words }, zooms: [], broll: [], audio: [], texts: [] };
  run(
    "update clips set edit_state = ?, edit_version = edit_version + 1, score_breakdown = ?, updated_at = ? where id = ?",
    JSON.stringify(edit),
    JSON.stringify({ montage: true, scenes: pieces.map((x) => x.sceneId) }),
    nowIso(),
    clipId,
  );
  createRender(clipId);
  return row<Clip>("clips", "select * from clips where id = ?", clipId)!;
}

function fullFrameTrack(duration: number) {
  return { version: 1, srcW: 1080, srcH: 1920, segments: [{ start: 0, end: Math.round(duration * 1000) / 1000, layout: "crop", keys: [{ t: 0, cx: 0.5, cy: 0.5 }] }] };
}
