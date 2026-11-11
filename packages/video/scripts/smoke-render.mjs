#!/usr/bin/env node
// End-to-end smoke test of the render CLI:
//   node packages/video/scripts/smoke-render.mjs [--keep]
// Generates a 6 s 1280x720 test video, renders a captioned 9:16 clip with a pan + hard cut,
// verifies the output with ffprobe and extracts a frame (JPEG) to inspect by eye.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const work = process.env.KLIPZ_SMOKE_DIR ?? path.join(os.tmpdir(), "klipz-smoke");
const storage = path.join(work, "storage");
fs.mkdirSync(path.join(storage, "src"), { recursive: true });

function findFfmpeg() {
  if (process.env.FFMPEG && process.env.FFPROBE) return { ffmpeg: process.env.FFMPEG, ffprobe: process.env.FFPROBE };
  const py = process.env.KLIPZ_PYTHON ?? path.join(os.homedir(), ".klipz", "venv", "Scripts", "python");
  const r = spawnSync(py, ["-c", "from static_ffmpeg import run; a,b=run.get_or_fetch_platform_executables_else_raise(); print(a); print(b)"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cannot locate ffmpeg: ${r.stderr}`);
  const [ffmpeg, ffprobe] = r.stdout.trim().split(/\r?\n/);
  return { ffmpeg, ffprobe };
}
const { ffmpeg, ffprobe } = findFfmpeg();

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} failed:\n${r.stderr}`);
  return r.stdout;
}

// 1. source video: moving test pattern + a pulsing "speech-like" tone
const srcRel = "src/test.mp4";
const srcAbs = path.join(storage, srcRel);
run(ffmpeg, [
  "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6",
  "-f", "lavfi", "-i", "sine=frequency=220:duration=6:sample_rate=48000",
  "-filter_complex", "[1:a]tremolo=f=4:d=0.9,volume=0.6[a]",
  "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", srcAbs,
]);

// 2. props: pan in the first 3 s, hard cut to the right side at t=3
const words = "This is the one thing nobody tells you about 10x growth and why it matters so much".split(" ");
const caption = words.map((w, i) => ({
  id: `w${i}`,
  w,
  s: 0.2 + i * 0.33,
  e: 0.2 + i * 0.33 + 0.3,
  ...(["thing", "10x", "growth"].includes(w) ? { emph: true } : {}),
  ...(w === "growth" ? { emoji: "📈" } : {}),
}));
const props = {
  sourceUrl: srcRel,
  srcW: 1280,
  srcH: 720,
  assetBaseUrl: "",
  cropTrack: {
    version: 1,
    srcW: 1280,
    srcH: 720,
    segments: [
      { start: 0, end: 3, layout: "crop", keys: [{ t: 0, cx: 0.2, cy: 0.5 }, { t: 3, cx: 0.45, cy: 0.5 }] },
      { start: 3, end: 6, layout: "crop", keys: [{ t: 3, cx: 0.85, cy: 0.5 }] },
    ],
  },
  edit: {
    version: 1,
    video: [{ id: "p1", srcStart: 0, srcEnd: 6 }],
    captions: { enabled: true, styleId: "comic-pop", overrides: {}, words: caption },
    broll: [],
    audio: [],
    texts: [],
    zooms: [{ id: "z1", t: 0, scale: 1, ease: "ease" }, { id: "z2", t: 6, scale: 1.12, ease: "ease" }],
    look: "none",
    hook: { enabled: true, text: "Nobody tells you this", durationSec: 3 },
    progressBar: { enabled: true, color: "#FFE600", position: "bottom", height: 14 },
    volume: 1,
    duckLevel: 0.25,
    safeZone: "tiktok",
  },
  showSafeZone: true, // must be ignored by renders
};
const propsPath = path.join(work, "props.json");
fs.writeFileSync(propsPath, JSON.stringify(props, null, 2));
const out = path.join(work, "out.mp4");
const cover = path.join(work, "cover.jpg");

// 3. render
console.error(`[smoke] rendering (first run bundles + may download Chrome Headless Shell)...`);
const events = [];
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(here, "..", "render.mjs"), "--props", propsPath, "--out", out, "--storage", storage, "--cover", cover, "--cover-frame", "75"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const ev = JSON.parse(line); // every stdout line must be JSON
      events.push(ev);
      if (ev.type !== "progress") console.error(`[smoke] ${line}`);
    }
  });
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`render.mjs exit ${code}: ${JSON.stringify(events.at(-1))}`))));
});

// 4. verify
const probe = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", out]));
const v = probe.streams.find((s) => s.codec_type === "video");
const a = probe.streams.find((s) => s.codec_type === "audio");
const dur = Number(probe.format.duration);
const checks = [
  ["video 1080x1920", v?.width === 1080 && v?.height === 1920],
  ["h264", v?.codec_name === "h264"],
  ["yuv420p", v?.pix_fmt === "yuv420p"],
  ["30 fps", v?.r_frame_rate === "30/1"],
  ["aac audio", a?.codec_name === "aac"],
  ["duration ~6s", Math.abs(dur - 6) < 0.2],
  ["done event", events.at(-1)?.type === "done" && events.at(-1)?.frames === 180],
  ["progress events", events.some((e) => e.type === "progress" && e.stage === "rendering")],
  ["cover exists", fs.existsSync(cover) && fs.statSync(cover).size > 5000],
];
// extract frames: one before and one after the hard cut, plus one with captions + hook
for (const [name, t] of [["frame-t1", 1], ["frame-t4", 4.2]]) {
  run(ffmpeg, ["-y", "-ss", String(t), "-i", out, "-frames:v", "1", "-q:v", "3", path.join(work, `${name}.jpg`)]);
}
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
  ok &&= !!pass;
}
console.log(`output: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KiB, ${dur.toFixed(2)} s)`);
console.log(`frames: ${path.join(work, "frame-t1.jpg")} ${path.join(work, "frame-t4.jpg")} ${cover}`);
void repoRoot;
process.exit(ok ? 0 : 1);
