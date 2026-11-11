#!/usr/bin/env node
// Real-render coverage of the paths smoke-render.mjs does not touch:
//   node packages/video/scripts/smoke-layouts.mjs
//   - split layout (two panes), letterbox + blurred background
//   - b-roll cover and pip (generated second video)
//   - extra audio item with ducking (measured with ffmpeg: main audio band quieter in the duck window)
//   - free text item, piece transitions (fade/slide/zoom/flash)
//   - caption highlight modes karaoke / box / scale (+ emoji line) rendered from `clip` only (no edit)
// Frames are written to KLIPZ_SMOKE_DIR/layouts (default <tmp>/klipz-smoke/layouts) to be inspected by eye.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = path.join(process.env.KLIPZ_SMOKE_DIR ?? path.join(os.tmpdir(), "klipz-smoke"), "layouts");
const storage = path.join(work, "storage");
fs.mkdirSync(path.join(storage, "src"), { recursive: true });
fs.mkdirSync(path.join(work, "frames"), { recursive: true });

function findFfmpeg() {
  if (process.env.FFMPEG && process.env.FFPROBE) return { ffmpeg: process.env.FFMPEG, ffprobe: process.env.FFPROBE };
  const py = process.env.KLIPZ_PYTHON ?? path.join(os.homedir(), ".klipz", "venv", "Scripts", "python");
  const r = spawnSync(py, ["-c", "from static_ffmpeg import run; a,b=run.get_or_fetch_platform_executables_else_raise(); print(a); print(b)"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot locate ffmpeg: ${r.stderr}`);
  const [ffmpeg, ffprobe] = r.stdout.trim().split(/\r?\n/);
  return { ffmpeg, ffprobe };
}
const { ffmpeg } = findFfmpeg();
function run(args) {
  const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed:\n${r.stderr.slice(-1500)}`);
  return r.stderr;
}

// ── generated inputs ────────────────────────────────────────────────────
// main: 12 s 1280x720, constant 220 Hz tone (so the duck is measurable)
run(["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=12", "-f", "lavfi", "-i", "sine=frequency=220:duration=12:sample_rate=48000",
  "-filter_complex", "[1:a]volume=0.5[a]", "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(storage, "src/main.mp4")]);
// b-roll: 3 s 640x360 colour bars, silent
run(["-y", "-f", "lavfi", "-i", "smptebars=size=640x360:rate=30:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", path.join(storage, "src/broll.mp4")]);
// music: 1 kHz tone (outside the 220 Hz band we measure)
run(["-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=3:sample_rate=48000", "-af", "volume=0.5", "-c:a", "aac", path.join(storage, "src/music.m4a")]);

function renderProps(name, props, { cover = false } = {}) {
  const propsPath = path.join(work, `${name}.props.json`);
  const out = path.join(work, `${name}.mp4`);
  fs.writeFileSync(propsPath, JSON.stringify(props));
  const args = [path.join(here, "..", "render.mjs"), "--props", propsPath, "--out", out, "--storage", storage];
  if (cover) args.push("--cover", path.join(work, `${name}.jpg`), "--cover-frame", "30");
  console.error(`[layouts] rendering ${name}...`);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`render ${name} failed (${r.status}): ${(r.stdout ?? "").slice(-600)}\n${(r.stderr ?? "").slice(-800)}`);
  return out;
}
const frame = (video, t, name) => {
  const f = path.join(work, "frames", `${name}.jpg`);
  run(["-y", "-ss", String(t), "-i", video, "-frames:v", "1", "-q:v", "3", f]);
  return f;
};
const meanVolume = (video, t0, dur, band) => {
  const err = run(["-ss", String(t0), "-t", String(dur), "-i", video, "-vn", "-af", `bandpass=f=${band}:width_type=h:w=60,volumedetect`, "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(err);
  return m ? Number(m[1]) : -Infinity;
};

// ── 1. main composite ───────────────────────────────────────────────────
const words = "This is the one thing nobody tells you about growth and why it really matters so much to everyone watching right now friend".split(" ");
const capWords = words.map((w, i) => ({ id: `w${i}`, w, s: 0.2 + i * 0.45, e: 0.2 + i * 0.45 + 0.4 }));
const main = {
  sourceUrl: "src/main.mp4",
  srcW: 1280,
  srcH: 720,
  assetBaseUrl: "",
  cropTrack: {
    version: 1,
    srcW: 1280,
    srcH: 720,
    segments: [
      { start: 0, end: 3, layout: "split", keys: [{ t: 0, cx: 0.25, cy: 0.5 }], keys2: [{ t: 0, cx: 0.75, cy: 0.5 }] },
      { start: 3, end: 6, layout: "letterbox", keys: [{ t: 3, cx: 0.5, cy: 0.5 }] },
      { start: 6, end: 12, layout: "crop", keys: [{ t: 6, cx: 0.5, cy: 0.5 }] },
    ],
  },
  edit: {
    version: 1,
    video: [
      { id: "p1", srcStart: 0, srcEnd: 3 },
      { id: "p2", srcStart: 3, srcEnd: 6, transitionIn: { type: "fade", durationSec: 0.6 } },
      { id: "p3", srcStart: 6, srcEnd: 8.5, transitionIn: { type: "slide", durationSec: 0.6 } },
      { id: "p4", srcStart: 8.5, srcEnd: 10, transitionIn: { type: "zoom", durationSec: 0.6 } },
      { id: "p5", srcStart: 10, srcEnd: 12, transitionIn: { type: "flash", durationSec: 0.6 } },
    ],
    captions: { enabled: true, styleId: "yellow-highlight", overrides: {}, words: capWords },
    broll: [
      { id: "b1", src: "src/broll.mp4", kind: "video", start: 4, duration: 1, srcOffset: 0, volume: 0, duck: false, fit: "cover" },
      { id: "b2", src: "src/broll.mp4", kind: "video", start: 7, duration: 1, srcOffset: 0, volume: 0, duck: false, fit: "pip" },
    ],
    audio: [{ id: "a1", src: "src/music.m4a", kind: "music", start: 8, duration: 2, srcOffset: 0, volume: 1, duck: true }],
    texts: [
      { id: "t1", text: "FREE TEXT ITEM\nsecond line", start: 1.5, duration: 2, x: 0.5, y: 0.3, fontFamily: "Montserrat", fontSize: 72, fontWeight: 800, color: "#ffffff", background: "rgba(0,0,0,0.55)", anim: "pop" },
    ],
    zooms: [],
    look: "none",
    hook: { enabled: false, text: "", durationSec: 3 },
    progressBar: { enabled: false, color: "#FFE600", position: "bottom", height: 14 },
    volume: 1,
    duckLevel: 0.25,
    safeZone: "none",
  },
};
const mainOut = renderProps("main", main);
const shots = [
  ["split-0.6s", 0.6], ["text-2.2s-in-split", 2.2], ["fade-3.15s", 3.15], ["letterbox-3.9s", 3.9], ["broll-cover-4.5s", 4.5],
  ["slide-6.2s", 6.2], ["broll-pip-7.5s", 7.5], ["zoom-8.6s", 8.6], ["flash-10.05s", 10.05], ["crop-11.5s", 11.5],
].map(([n, t]) => frame(mainOut, t, n));

// ducking: band-limited (220 Hz) level of the main audio inside vs outside the duck window (8..10 s)
const outside = meanVolume(mainOut, 4.5, 2, 220);
const ducked = meanVolume(mainOut, 8.4, 1.2, 220);
const drop = outside - ducked;
console.log(`duck: 220 Hz band mean ${outside} dB outside vs ${ducked} dB inside (drop ${drop.toFixed(1)} dB, expected ~12 dB for duckLevel 0.25)`);
const musicIn = meanVolume(mainOut, 8.4, 1.2, 1000);
const musicOut = meanVolume(mainOut, 4.5, 2, 1000);
console.log(`music 1 kHz band: ${musicIn} dB inside window, ${musicOut} dB outside`);

// ── 2. caption highlight modes, from `clip` only (no edit) ───────────────
const sentence = "This is the money you will love, fire growth".split(" ");
const seedWords = sentence.map((w, i) => ({ w, s: i * 0.3, e: i * 0.3 + 0.28 }));
const modes = [["karaoke-neon", "karaoke"], ["yellow-highlight", "box"], ["comic-pop", "scale-emoji"]];
for (const [styleId, label] of modes) {
  const out = renderProps(`cap-${label}`, {
    sourceUrl: "src/main.mp4", srcW: 1280, srcH: 720, assetBaseUrl: "",
    clip: { start: 0, end: 2.6, words: seedWords, styleId, keywords: ["money", "love", "fire", "growth"] },
  });
  // 1.0 s: mid-page (1.2 s is the page boundary, where entrance animations are still at frame 0)
  shots.push(frame(out, 1.0, `caption-${label}`));
}

// ── checks ──────────────────────────────────────────────────────────────
const checks = [
  ["frames exist", shots.every((f) => fs.existsSync(f) && fs.statSync(f).size > 3000)],
  ["main audio ducked >= 8 dB in the window", drop >= 8],
  ["music audible in the window, absent outside", musicIn > musicOut + 15],
];
let ok = true;
for (const [n, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} ${n}`);
  ok &&= !!pass;
}
console.log(`frames: ${path.join(work, "frames")}`);
process.exit(ok ? 0 : 1);
