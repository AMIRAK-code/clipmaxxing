#!/usr/bin/env node
// Local demo data without the worker: a generated 45 s test video, a word-level
// transcript and 3 scored clips with crop tracks. Idempotent: re-running
// replaces the project titled "KLIPZ demo".
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.KLIPZ_DATA_DIR?.trim() || path.join(os.homedir(), ".klipz");
const storage = path.join(dataDir, "storage");
fs.mkdirSync(storage, { recursive: true });

const TITLE = "KLIPZ demo";
const DURATION = 45;
const W = 1280;
const H = 720;
const FPS = 30;

// ── ffmpeg ──────────────────────────────────────────────────────────────
function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const venv = process.env.KLIPZ_VENV || path.join(os.homedir(), ".klipz", "venv");
  const py = [path.join(venv, "Scripts", "python.exe"), path.join(venv, "bin", "python")].find((p) => fs.existsSync(p));
  if (py) {
    const r = spawnSync(py, ["-c", "from static_ffmpeg import run; print(run.get_or_fetch_platform_executables_else_raise()[0])"], { encoding: "utf8" });
    const out = r.stdout?.trim().split(/\r?\n/).pop();
    if (r.status === 0 && out && fs.existsSync(out)) return out;
  }
  return "ffmpeg";
}
const ffmpeg = findFfmpeg();

function makeVideo(out) {
  // Five 9 s shots with clearly different looks, plus a tone pattern that changes per shot.
  const shots = [
    "testsrc2=size=1280x720:rate=30:duration=9",
    "testsrc2=size=1280x720:rate=30:duration=9,hue=h=120",
    "mandelbrot=size=1280x720:rate=30,trim=duration=9,setpts=PTS-STARTPTS",
    "smptebars=size=1280x720:rate=30:duration=9",
    "testsrc2=size=1280x720:rate=30:duration=9,hue=h=240,negate",
  ];
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const s of shots) args.push("-f", "lavfi", "-i", s);
  args.push("-f", "lavfi", "-i", `aevalsrc=0.35*sin(2*PI*(220+110*floor(t/9))*t)*lt(mod(t\\,1)\\,0.7)|0.35*sin(2*PI*(330+110*floor(t/9))*t)*lt(mod(t\\,1)\\,0.7):s=44100:d=${DURATION}`);
  const labels = shots.map((_, i) => `[${i}:v]format=yuv420p,setsar=1,fps=${FPS}[v${i}]`).join(";");
  const concat = `${shots.map((_, i) => `[v${i}]`).join("")}concat=n=${shots.length}:v=1:a=0[v]`;
  args.push("-filter_complex", `${labels};${concat}`, "-map", "[v]", "-map", `${shots.length}:a`);
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-g", "30", "-c:a", "aac", "-b:a", "128k", "-t", String(DURATION), "-movflags", "+faststart", out);
  const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr || r.error}`);
}

function makeThumb(video, out) {
  const r = spawnSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-ss", "4", "-i", video, "-frames:v", "1", "-vf", "scale=640:-2", out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`thumbnail failed: ${r.stderr}`);
}

// ── db (same logic as apps/web/src/server/db.ts) ────────────────────────
function openDb() {
  const db = new DatabaseSync(path.join(dataDir, "klipz.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  const dir = path.join(root, "db", "migrations");
  const current = Number(db.prepare("PRAGMA user_version").get().user_version ?? 0);
  for (const f of fs.readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const v = Number.parseInt(f, 10);
    if (v <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (v > Number(db.prepare("PRAGMA user_version").get().user_version ?? 0)) {
        db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
        db.exec(`PRAGMA user_version = ${v}`);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

// ── transcript ──────────────────────────────────────────────────────────
const SENTENCES = [
  "Nobody tells you this about building a business in 2025.",
  "Most founders waste 90 percent of their time on the wrong things.",
  "Here is the secret that changed everything for me.",
  "Stop chasing every idea and pick one problem worth solving.",
  "I made my first million dollars by doing less, not more!",
  "The truth is simple, focus beats talent every single time.",
  "Why does nobody talk about this?",
  "Because the growth hack industry wants you confused.",
  "So here is what you do tomorrow morning.",
  "Write down one number that matters, and ignore everything else.",
  "That is the whole strategy, and it is surprisingly powerful.",
  "Try it for thirty days and watch what happens.",
];

function buildTranscript() {
  const words = [];
  const segments = [];
  let t = 0.6;
  const per = (DURATION - 2) / SENTENCES.length;
  SENTENCES.forEach((text, si) => {
    const toks = text.split(" ");
    const chars = toks.reduce((n, w) => n + w.length + 2, 0);
    const avail = per - 0.35;
    const s0 = Math.max(t, 0.6 + si * per);
    let cur = s0;
    for (const tok of toks) {
      const d = (avail * (tok.length + 2)) / chars;
      words.push({ w: tok, s: round(cur), e: round(cur + d * 0.94), p: 0.9, spk: "S1" });
      cur += d;
    }
    segments.push({ s: round(s0), e: round(cur), text, spk: "S1" });
    t = cur + 0.35;
  });
  return { words, segments };
}
const round = (v) => Math.round(v * 1000) / 1000;

const key = (t, cx, cy = 0.5) => ({ t, cx, cy });

// Crop tracks live in source time. Shots change at 9, 18, 27, 36 s.
const CLIPS = [
  {
    start: 3, end: 33, score: 91, title: "The one-number strategy", status: "kept", style: "bold-outline",
    hook: "Nobody tells you this about building a business",
    reason: "Strong opening claim, clear payoff and a concrete action step.",
    breakdown: { hook: 94, context: 84, emotion: 78, payoff: 92, llm: 0, energy: 80, cuts: 70, scorer: "heuristic-v1", keywords: ["business", "secret", "million", "focus", "number"] },
    segments: [
      { start: 3, end: 9, layout: "crop", keys: [key(3, 0.3), key(6, 0.5), key(9, 0.72)] },
      { start: 9, end: 18, layout: "crop", keys: [key(9, 0.5, 0.4)] },
      { start: 18, end: 27, layout: "split", keys: [key(18, 0.3), key(27, 0.4)], keys2: [key(18, 0.7), key(27, 0.6)] },
      { start: 27, end: 33, layout: "letterbox", keys: [key(27, 0.5)] },
    ],
  },
  {
    start: 10, end: 38, score: 78, title: "Focus beats talent", status: "candidate", style: "yellow-highlight",
    hook: "Focus beats talent every single time",
    reason: "Punchy thesis statement; good energy through the middle.",
    breakdown: { hook: 80, context: 70, emotion: 74, payoff: 81, llm: 0, energy: 76, cuts: 60, scorer: "heuristic-v1", keywords: ["focus", "talent", "growth"] },
    segments: [
      { start: 10, end: 18, layout: "crop", keys: [key(10, 0.7), key(18, 0.3)] },
      { start: 18, end: 27, layout: "letterbox", keys: [key(18, 0.5)] },
      { start: 27, end: 36, layout: "crop", keys: [key(27, 0.5, 0.45), key(36, 0.6, 0.55)] },
      { start: 36, end: 38, layout: "crop", keys: [key(36, 0.25)] },
    ],
  },
  {
    start: 20, end: 44, score: 63, title: "Try it for thirty days", status: "candidate", style: "karaoke-neon",
    hook: "Write down one number that matters",
    reason: "Actionable closing section, slightly slower pacing.",
    breakdown: { hook: 58, context: 62, emotion: 55, payoff: 74, llm: 0, energy: 60, cuts: 52, scorer: "heuristic-v1", keywords: ["number", "strategy", "powerful"] },
    segments: [
      { start: 20, end: 27, layout: "split", keys: [key(20, 0.35), key(27, 0.5)], keys2: [key(20, 0.65), key(27, 0.5)] },
      { start: 27, end: 36, layout: "crop", keys: [key(27, 0.4), key(36, 0.6)] },
      { start: 36, end: 44, layout: "crop", keys: [key(36, 0.5, 0.5)] },
    ],
  },
];

function main() {
  const db = openDb();
  // Replace any previous demo.
  const old = db.prepare("select id from projects where title = ?").all(TITLE);
  for (const p of old) {
    for (const s of db.prepare("select id from source_videos where project_id = ?").all(p.id)) {
      fs.rmSync(path.join(storage, "sources", s.id), { recursive: true, force: true });
    }
    for (const c of db.prepare("select id from clips where project_id = ?").all(p.id)) {
      fs.rmSync(path.join(storage, "clips", c.id), { recursive: true, force: true });
    }
    db.prepare("delete from projects where id = ?").run(p.id);
  }

  const projectId = randomUUID();
  const sourceId = randomUUID();
  const dir = path.join(storage, "sources", sourceId);
  fs.mkdirSync(dir, { recursive: true });
  const videoPath = path.join(dir, "source.mp4");
  console.log("Generating test video with", ffmpeg);
  makeVideo(videoPath);
  makeThumb(videoPath, path.join(dir, "thumb.jpg"));
  const size = fs.statSync(videoPath).size;

  const rms = Array.from({ length: DURATION * 2 }, (_, i) => round(0.35 + 0.3 * Math.abs(Math.sin(i / 5)) + (i % 2 === 0 ? 0.05 : 0)));
  const { words, segments } = buildTranscript();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("insert into projects (id, title) values (?, ?)").run(projectId, TITLE);
    db.prepare(
      `insert into source_videos (id, project_id, origin, filename, storage_key, size_bytes, duration_sec, width, height, fps, status, scene_cuts, energy)
       values (?, ?, 'upload', 'demo.mp4', ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    ).run(sourceId, projectId, `sources/${sourceId}/source.mp4`, size, DURATION, W, H, FPS, JSON.stringify([9, 18, 27, 36]), JSON.stringify({ hop: 0.5, rms }));
    db.prepare("insert into transcripts (id, source_video_id, language, words, segments, speakers, model) values (?, ?, 'en', ?, ?, ?, 'seed')").run(
      randomUUID(), sourceId, JSON.stringify(words), JSON.stringify(segments), JSON.stringify(["S1"]),
    );
    const ids = [];
    for (const c of CLIPS) {
      const id = randomUUID();
      ids.push(id);
      db.prepare(
        `insert into clips (id, project_id, source_video_id, start_sec, end_sec, score, score_breakdown, title, hook, reason, status, crop_track, caption_style_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, projectId, sourceId, c.start, c.end, c.score, JSON.stringify(c.breakdown), c.title, c.hook, c.reason, c.status,
        JSON.stringify({ version: 1, srcW: W, srcH: H, segments: c.segments }), c.style,
      );
    }
    db.exec("COMMIT");
    console.log(`Seeded "${TITLE}" (project ${projectId}) in ${dataDir}`);
    ids.forEach((id, i) => console.log(`  clip ${i + 1}: http://127.0.0.1:3000/clips/${id}`));
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.close();
}

main();
