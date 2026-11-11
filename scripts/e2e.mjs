#!/usr/bin/env node
// Full end-to-end test of KLIPZ through its public HTTP API only (what the browser does).
//
//   npm run e2e                 run (fresh temp data dir, sandbox posting, whisper "tiny")
//   npm run e2e -- --keep       keep the temp data dir afterwards
//   npm run e2e -- --dev        use next dev instead of the production build
//
// Env overrides: E2E_WEB_PORT (3100), E2E_WORKER_PORT (8797), WHISPER_MODEL (tiny), E2E_TIMEOUT_MIN (20).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { venvPython, killTree } from "./start.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");
const DEV = process.argv.includes("--dev");
const WEB_PORT = Number(process.env.E2E_WEB_PORT) || 3100;
const WORKER_PORT = Number(process.env.E2E_WORKER_PORT) || 8797;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const DEADLINE = Date.now() + (Number(process.env.E2E_TIMEOUT_MIN) || 20) * 60_000;
const PROVIDERS = ["tiktok", "youtube", "instagram", "facebook", "x", "linkedin"];
const MIN = 60_000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "klipz-e2e-"));
const t0 = Date.now();
const results = [];
let launcher = null;
let launcherLog = "";
let sse = null;

const ts = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (m) => console.log(`${ts()}  ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AssertionError extends Error {}
function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}

async function step(name, fn) {
  const s = Date.now();
  log(`>> ${name}`);
  try {
    const out = await fn();
    const ms = Date.now() - s;
    results.push({ name, ok: true, ms });
    log(`   ok   (${(ms / 1000).toFixed(1)}s)`);
    return out;
  } catch (e) {
    const ms = Date.now() - s;
    results.push({ name, ok: false, ms, error: e instanceof Error ? e.message : String(e) });
    log(`   FAIL (${(ms / 1000).toFixed(1)}s): ${e instanceof Error ? e.message : e}`);
    throw e;
  }
}

// ── HTTP helpers (same-origin headers like the browser sends) ────────────
async function api(method, url, body, extra = {}) {
  const headers = { origin: BASE, ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...extra };
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}
async function ok(method, url, body, extra) {
  const r = await api(method, url, body, extra);
  assert(r.status >= 200 && r.status < 300, `${method} ${url} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

async function waitFor(what, fn, { timeoutMs = 10 * MIN, everyMs = 1000 } = {}) {
  const end = Math.min(Date.now() + timeoutMs, DEADLINE);
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > end) throw new AssertionError(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

// ── SSE follower for /api/events ─────────────────────────────────────────
function followEvents(projectId) {
  const state = { jobs: new Map(), events: 0, worker: null, abort: new AbortController() };
  (async () => {
    try {
      const res = await fetch(`${BASE}/api/events?projectId=${projectId}`, { signal: state.abort.signal, headers: { accept: "text/event-stream" } });
      assert(res.ok && (res.headers.get("content-type") ?? "").startsWith("text/event-stream"), "SSE endpoint did not answer text/event-stream");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev || !data) continue;
          state.events++;
          const j = JSON.parse(data);
          if (ev === "job") state.jobs.set(j.id, j);
          if (ev === "worker") state.worker = j.alive;
        }
      }
    } catch (e) {
      if (!state.abort.signal.aborted) log(`   (SSE stream ended: ${e.message})`);
    }
  })();
  return state;
}

// ── media helpers ────────────────────────────────────────────────────────
function tools(statusJson) {
  const ffmpeg = statusJson.status.ffmpeg.path;
  const probeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const sibling = path.join(path.dirname(ffmpeg), probeName);
  return { ffmpeg, ffprobe: fs.existsSync(sibling) ? sibling : probeName };
}
const run = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

async function topLevelBoxes(key, size) {
  // Walk the MP4 box headers with tiny Range requests: proves Range serving AND finds moov/mdat order.
  const out = [];
  let off = 0;
  while (off < size && out.length < 12) {
    const res = await fetch(`${BASE}/api/files/${key}`, { headers: { range: `bytes=${off}-${off + 15}` } });
    assert(res.status === 206, `Range request returned ${res.status}, expected 206`);
    const cr = res.headers.get("content-range");
    assert(cr === `bytes ${off}-${Math.min(off + 15, size - 1)}/${size}`, `bad content-range ${cr}`);
    const b = Buffer.from(await res.arrayBuffer());
    let len = b.readUInt32BE(0);
    const type = b.toString("latin1", 4, 8);
    if (len === 1) len = Number(b.readBigUInt64BE(8));
    out.push(type);
    if (type === "mdat" || len < 8) break;
    off += len;
  }
  return out;
}

async function verifyRender(render, label, tl) {
  assert(render.status === "ready" && render.storage_key, `${label}: render not ready (${render.status}: ${render.error ?? ""})`);
  const key = render.storage_key.split("/").map(encodeURIComponent).join("/");
  const head = await fetch(`${BASE}/api/files/${key}`, { headers: { range: "bytes=0-99" } });
  assert(head.status === 206, `${label}: Range gave ${head.status}`);
  const size = Number(/\/(\d+)$/.exec(head.headers.get("content-range") ?? "")?.[1]);
  assert(size > 10_000, `${label}: file too small (${size})`);
  await head.arrayBuffer();
  const file = path.join(tmp, `${label.replace(/\W+/g, "_")}.mp4`);
  const full = await fetch(`${BASE}/api/files/${key}`);
  assert(full.status === 200, `${label}: full download ${full.status}`);
  fs.writeFileSync(file, Buffer.from(await full.arrayBuffer()));
  assert(fs.statSync(file).size === size, `${label}: downloaded size differs from content-range total`);

  const p = JSON.parse(run(tl.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).stdout);
  const v = p.streams.find((s) => s.codec_type === "video");
  const a = p.streams.find((s) => s.codec_type === "audio");
  assert(v && v.width === 1080 && v.height === 1920, `${label}: video is ${v?.width}x${v?.height}, expected 1080x1920`);
  assert(v.codec_name === "h264", `${label}: video codec ${v.codec_name}`);
  assert(a && a.codec_name === "aac", `${label}: audio codec ${a?.codec_name}`);
  const dur = Number(p.format.duration);
  assert(dur > 3, `${label}: duration ${dur}`);

  const boxes = await topLevelBoxes(key, size);
  assert(boxes.includes("moov") && boxes.indexOf("moov") < boxes.indexOf("mdat"), `${label}: not faststart (boxes ${boxes.join(",")})`);

  const loud = run(tl.ffmpeg, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]).stderr;
  const lufs = Number(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/.exec(loud.slice(loud.lastIndexOf("Summary")))?.[1]);
  assert(Number.isFinite(lufs) && Math.abs(lufs + 14) <= 1, `${label}: loudness ${lufs} LUFS, expected -14 +/- 1`);
  log(`   ${label}: ${v.width}x${v.height} ${v.codec_name}+${a.codec_name} ${dur.toFixed(1)}s faststart (${boxes.join(">")}) ${lufs.toFixed(2)} LUFS ${(size / 1e6).toFixed(1)} MB`);
  return { lufs, dur, size };
}

// ── process management ───────────────────────────────────────────────────
function startLauncher(env) {
  const args = [path.join(root, "scripts", "start.mjs"), ...(DEV ? ["--dev"] : ["--no-build"])];
  launcher = spawn(process.execPath, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const sink = (d) => {
    launcherLog += d;
    if (launcherLog.length > 400_000) launcherLog = launcherLog.slice(-300_000);
  };
  launcher.stdout.on("data", sink);
  launcher.stderr.on("data", sink);
}

function stopLauncher() {
  if (sse) sse.abort.abort();
  killTree(launcher);
}

function portsFree() {
  const r = spawnSync(process.platform === "win32" ? "netstat" : "ss", process.platform === "win32" ? ["-ano"] : ["-ltn"], { encoding: "utf8" });
  return [WEB_PORT, WORKER_PORT].filter((p) => new RegExp(`[:.]${p}\\s`).test(r.stdout ?? "") && /LISTEN/i.test((r.stdout ?? "").split("\n").find((l) => new RegExp(`[:.]${p}\\s`).test(l)) ?? ""));
}

// ── the test ─────────────────────────────────────────────────────────────
async function main() {
  const busy = portsFree();
  if (busy.length) throw new Error(`Port(s) ${busy.join(", ")} already in use. Set E2E_WEB_PORT / E2E_WORKER_PORT to free ports.`);
  log(`temp data dir: ${tmp}`);
  const env = {
    ...process.env,
    KLIPZ_DATA_DIR: tmp,
    KLIPZ_PUBLISH_MOCK: "1",
    WHISPER_MODEL: process.env.WHISPER_MODEL || "tiny",
    KLIPZ_PORT: String(WEB_PORT),
    KLIPZ_WORKER_PORT: String(WORKER_PORT),
    APP_URL: BASE,
    LLM_PROVIDER: process.env.LLM_PROVIDER || "none", // deterministic heuristic scorer, no network
  };
  delete env.NO_COLOR;

  const sample = path.join(tmp, "samples", "sample.mp4");
  await step("generate sample video (scripts/make-sample.py)", async () => {
    const { python } = venvPython(env);
    assert(python, "worker venv python not found (see npm start for instructions)");
    const r = spawnSync(python, [path.join(root, "scripts", "make-sample.py"), "--out", sample], { encoding: "utf8", env, timeout: 5 * MIN });
    assert(r.status === 0 && fs.existsSync(sample), `make-sample failed: ${(r.stderr || r.stdout || "").slice(-400)}`);
    log(`   ${sample} (${(fs.statSync(sample).size / 1e6).toFixed(1)} MB)`);
  });

  await step(`start web (:${WEB_PORT}) + worker (:${WORKER_PORT}) via scripts/start.mjs`, async () => {
    startLauncher(env);
    const status = await waitFor("web app + worker online", async () => {
      if (launcher.exitCode !== null) throw new AssertionError(`launcher exited early (${launcher.exitCode}):\n${launcherLog.slice(-1500)}`);
      try {
        const r = await api("GET", "/api/system/status");
        return r.status === 200 && r.json?.status?.worker?.online ? r.json : null;
      } catch {
        return null;
      }
    }, { timeoutMs: 3 * MIN });
    assert(/\[scheduler\] started/.test(launcherLog), "in-app scheduler did not log its start");
    assert((launcherLog.match(/\[scheduler\] started/g) ?? []).length === 1, "scheduler started more than once");
    return status;
  });
  const status0 = (await ok("GET", "/api/system/status")).status;
  const tl = tools({ status: status0 });
  assert(status0.ffmpeg.ok, "ffmpeg not available according to /api/system/status");

  // ── upload (chunked) ──
  const bytes = fs.readFileSync(sample);
  const up = await step("chunked upload via /api/uploads", async () => {
    const start = await ok("POST", "/api/uploads", { filename: "e2e-sample.mp4", size: bytes.length });
    const chunk = Math.min(start.chunkSize, Math.max(256 * 1024, Math.ceil(bytes.length / 4)));
    let sent = 0;
    let parts = 0;
    while (sent < bytes.length) {
      const piece = bytes.subarray(sent, Math.min(bytes.length, sent + chunk));
      const r = await ok("PUT", `/api/uploads/${start.sourceId}?offset=${sent}`, new Uint8Array(piece), { "content-type": "application/octet-stream" });
      assert(r.received === sent + piece.length, `server received ${r.received}, expected ${sent + piece.length}`);
      sent += piece.length;
      parts++;
    }
    const short = await api("POST", `/api/uploads/${start.sourceId}`); // finish
    assert(short.status === 200 && short.json.job, `finish upload -> ${short.status} ${short.text}`);
    log(`   ${parts} chunks, ${bytes.length} bytes`);
    return start;
  });
  sse = followEvents(up.projectId);

  await step("wait for ingest", async () => {
    const proj = await waitFor("source ready", async () => {
      const p = await ok("GET", `/api/projects/${up.projectId}`);
      const bad = p.jobs.find((j) => ["failed", "dead"].includes(j.status));
      if (bad) throw new AssertionError(`job ${bad.type} ${bad.status}: ${bad.error}`);
      return p.source && p.source.status === "ready" ? p : null;
    }, { timeoutMs: 5 * MIN });
    assert(proj.source.duration_sec > 60, `source duration ${proj.source.duration_sec}`);
    log(`   source ready: ${proj.source.duration_sec.toFixed(1)} s ${proj.source.width}x${proj.source.height}`);
  });

  // ── autoclip ──
  await step("POST /api/jobs autoclip (max 2 clips) and follow SSE", async () => {
    const { job } = await ok("POST", "/api/jobs", { type: "autoclip", sourceVideoId: up.sourceId, maxClips: 2 });
    let lastStage = "";
    await waitFor("autoclip job", async () => {
      const j = sse.jobs.get(job.id) ?? (await ok("GET", `/api/jobs/${job.id}`)).job;
      if (j.stage && j.stage !== lastStage) {
        lastStage = j.stage;
        log(`   autoclip: ${j.stage} ${Math.round((j.progress ?? 0) * 100)}%`);
      }
      if (["failed", "dead", "cancelled"].includes(j.status)) throw new AssertionError(`autoclip ${j.status}: ${j.error}`);
      return j.status === "succeeded";
    }, { timeoutMs: 15 * MIN, everyMs: 700 });
    assert(sse.events > 0, "no events arrived through /api/events");
    log(`   SSE delivered ${sse.events} events (${sse.jobs.size} distinct jobs)`);
  });

  const clips = await step("clips exist and renders become ready", async () => {
    const p0 = await ok("GET", `/api/projects/${up.projectId}`);
    assert(p0.clips.length >= 1 && p0.clips.length <= 2, `expected 1-2 clips, got ${p0.clips.length}`);
    let created = false;
    const final = await waitFor("all renders ready", async () => {
      const p = await ok("GET", `/api/projects/${up.projectId}`);
      const bad = p.jobs.find((j) => ["failed", "dead"].includes(j.status));
      if (bad) throw new AssertionError(`job ${bad.type} ${bad.status}: ${bad.error}`);
      const missing = p.clips.filter((c) => !p.renders[c.id]);
      if (missing.length && !p.jobs.some((j) => ["queued", "running"].includes(j.status))) {
        if (!created) {
          created = true;
          log("   autoclip did not queue renders itself; exporting each clip");
          for (const c of missing) await ok("POST", `/api/clips/${c.id}/renders`, {});
        }
        return null;
      }
      return p.clips.every((c) => p.renders[c.id]?.status === "ready") ? p : null;
    }, { timeoutMs: 15 * MIN, everyMs: 1500 });
    return final.clips;
  });

  for (const c of clips) {
    const d = await ok("GET", `/api/clips/${c.id}`);
    const r = d.renders.find((x) => x.status === "ready");
    assert(r, `clip ${c.id} has no ready render`);
    await step(`verify first render of clip ${c.id.slice(0, 8)} (Range, ffprobe, faststart, LUFS)`, () => verifyRender(r, `clip-${c.id.slice(0, 8)}-v1`, tl));
  }

  // ── edit + re-export ──
  const target = clips[0];
  const firstRender = await step("open clip (GET /api/clips/:id)", async () => {
    const d = await ok("GET", `/api/clips/${target.id}`);
    assert(d.clip.id === target.id && d.source && Array.isArray(d.words), "clip detail shape");
    assert(d.words.length > 0, "clip detail returned no transcript words");
    return d.renders.find((x) => x.status === "ready");
  });
  const edited = await step("PATCH edit_state (hook card on + caption preset) with expected_version", async () => {
    const d = await ok("GET", `/api/clips/${target.id}`);
    const clip = d.clip;
    const base = clip.edit_state ?? {
      version: 1,
      video: [{ id: "v_e2e", srcStart: clip.start_sec, srcEnd: clip.end_sec }],
      captions: {
        enabled: true,
        styleId: "bold-outline",
        overrides: {},
        words: d.words.filter((w) => w.e > clip.start_sec && w.s < clip.end_sec && w.w.trim()).map((w, i) => ({ id: `w${i}_${Math.round(w.s * 1000)}`, w: w.w.trim(), s: w.s, e: w.e })),
      },
      broll: [], audio: [], texts: [], zooms: [], look: "none",
      hook: { enabled: false, text: "", durationSec: 3 },
      progressBar: { enabled: false, color: "#FFE600", position: "bottom", height: 10 },
      volume: 1, duckLevel: 0.25, safeZone: "tiktok",
    };
    const next = {
      ...base,
      captions: { ...base.captions, styleId: base.captions.styleId === "yellow-highlight" ? "karaoke-neon" : "yellow-highlight" },
      hook: { enabled: true, text: clip.hook || clip.title || "Watch this", durationSec: 3 },
    };
    const stale = await api("PATCH", `/api/clips/${target.id}`, { edit_state: next, expected_version: clip.edit_version + 5 });
    assert(stale.status === 409, `stale expected_version should be 409, got ${stale.status}`);
    const res = await ok("PATCH", `/api/clips/${target.id}`, { edit_state: next, expected_version: clip.edit_version });
    assert(res.clip.edit_version === clip.edit_version + 1, `edit_version ${res.clip.edit_version}, expected ${clip.edit_version + 1}`);
    assert(res.clip.edit_state.hook.enabled === true, "hook not saved");
    assert(res.clip.edit_state.captions.styleId === next.captions.styleId, "caption preset not saved");
    return res.clip;
  });
  const second = await step("export again (POST /api/clips/:id/renders) and wait", async () => {
    const q = await ok("POST", `/api/clips/${target.id}/renders`, {});
    assert(q.render.edit_version === edited.edit_version, `render stamped with edit_version ${q.render.edit_version}`);
    const r = await waitFor("second render ready", async () => {
      const v = (await ok("GET", `/api/clips/${target.id}/renders`)).renders.find((x) => x.id === q.render.id);
      if (v.status === "failed") throw new AssertionError(`render failed: ${v.error}`);
      return v.status === "ready" ? v : null;
    }, { timeoutMs: 10 * MIN, everyMs: 1500 });
    return r;
  });
  await step("first render is reported outdated, the new one is not; verify new file", async () => {
    const views = (await ok("GET", `/api/clips/${target.id}/renders`)).renders;
    const old = views.find((x) => x.id === firstRender.id);
    const fresh = views.find((x) => x.id === second.id);
    assert(old.outdated === true, "first render should be outdated after the edit");
    assert(fresh.outdated === false, "new render should not be outdated");
    assert(Array.isArray(fresh.platforms) && fresh.platforms.length === 6, "platform checks missing on ready render");
    await verifyRender(fresh, "clip-edited-v2", tl);
  });

  // ── sandbox accounts + posting ──
  const accounts = await step("create sandbox accounts for all six providers", async () => {
    for (const provider of PROVIDERS) await ok("POST", "/api/accounts/sandbox", { provider });
    const list = (await ok("GET", "/api/accounts")).accounts;
    for (const provider of PROVIDERS) assert(list.some((a) => a.provider === provider && a.status === "active"), `no active ${provider} account`);
    assert(JSON.stringify(list).indexOf("sandbox-access-token") < 0, "token leaked through /api/accounts");
    return Object.fromEntries(PROVIDERS.map((p) => [p, list.find((a) => a.provider === p)]));
  });

  const postBody = (extra = {}) => ({
    clipId: target.id,
    renderId: second.id,
    accountIds: PROVIDERS.map((p) => accounts[p].id),
    caption: "KLIPZ end-to-end test clip",
    hashtags: ["klipz", "e2e"],
    title: "KLIPZ e2e clip",
    ...extra,
  });
  const failAccount = accounts.x.id;
  const batch = await step("validate + create six posts (one with [fail-once])", async () => {
    const body = postBody({ overrides: { [failAccount]: { caption: "KLIPZ e2e [fail-once]" } }, options: { tiktok: { privacyLevel: "SELF_ONLY", consentAccepted: true } } });
    const noConsent = await ok("POST", "/api/posts/validate", { ...body, options: { tiktok: { privacyLevel: "SELF_ONLY" } } });
    assert(Object.values(noConsent.issues).flat().some((i) => i.code === "consent_required"), "TikTok without consent should be rejected by validation");
    const refused = await api("POST", "/api/posts", { ...body, options: { tiktok: { privacyLevel: "SELF_ONLY" } } });
    assert(refused.status === 422, `POST /api/posts without TikTok consent -> ${refused.status}, expected 422`);
    const v = await ok("POST", "/api/posts/validate", body);
    for (const [id, issues] of Object.entries(v.issues)) assert(!issues.some((i) => i.severity === "error"), `validation error for ${id}: ${JSON.stringify(issues)}`);
    assert(Object.keys(v.composed).length === 6, "validate did not compose all six");
    const r = await api("POST", "/api/posts", body);
    assert(r.status === 201, `POST /api/posts -> ${r.status} ${r.text.slice(0, 500)}`);
    assert(r.json.posts.length === 6, "expected six posts");
    return r.json;
  });

  await step("cron ticks publish every post (fail-once retried, external URLs present)", async () => {
    const base = Date.now();
    let posts = [];
    for (let i = 1; i <= 14; i++) {
      const now = new Date(base + i * 2 * MIN).toISOString();
      const t = await ok("POST", "/api/cron/tick", { now });
      posts = (await ok("GET", `/api/posts?batchId=${batch.batchId}`)).posts;
      log(`   tick ${i}: ${posts.map((p) => `${p.provider}:${p.status}`).join(" ")}  (processed ${t.tick.processed})`);
      const failed = posts.filter((p) => p.status === "failed");
      assert(failed.length === 0, `posts failed: ${failed.map((p) => `${p.provider}: ${p.error}`).join("; ")}`);
      if (posts.every((p) => p.status === "published")) break;
    }
    assert(posts.length === 6 && posts.every((p) => p.status === "published"), `not all published: ${posts.map((p) => `${p.provider}:${p.status}`).join(" ")}`);
    for (const p of posts) assert(/^https?:\/\//.test(p.external_url ?? ""), `${p.provider}: missing external url`);
    const once = posts.find((p) => p.social_account_id === failAccount);
    assert(once.attempts > 1, `fail-once post attempts = ${once.attempts}, expected > 1`);
    for (const p of posts.filter((x) => x.id !== once.id)) assert(p.attempts === 1, `${p.provider}: attempts ${p.attempts}, expected 1 (no duplicate publish)`);
    log(`   fail-once post (x) needed ${once.attempts} attempts`);
  });

  await step("scheduled batch is NOT published by a tick, then is after reschedule / clock advance", async () => {
    const inOneHour = new Date(Date.now() + 60 * MIN).toISOString();
    const r = await ok("POST", "/api/posts", postBody({ accountIds: [accounts.youtube.id, accounts.linkedin.id], scheduledAt: inOneHour, caption: "KLIPZ scheduled e2e", timezone: "Europe/Berlin" }));
    assert(r.posts.every((p) => p.status === "scheduled"), "future posts should be 'scheduled'");
    await ok("POST", "/api/cron/tick", {}); // real clock
    let posts = (await ok("GET", `/api/posts?batchId=${r.batchId}`)).posts;
    assert(posts.every((p) => p.status === "scheduled"), `a tick published a future post: ${posts.map((p) => p.status)}`);
    const [a, b] = r.posts;
    const later = new Date(Date.now() + 120 * MIN).toISOString();
    const re = await ok("POST", `/api/posts/${a.id}`, { action: "reschedule", scheduledAt: later });
    assert(new Date(re.post.scheduled_at).getTime() === new Date(later).getTime(), "reschedule did not change scheduled_at");
    await ok("POST", "/api/cron/tick", { now: new Date(Date.now() + 90 * MIN).toISOString() }); // b due (+60), a not (+120)
    posts = (await ok("GET", `/api/posts?batchId=${r.batchId}`)).posts;
    const pa = posts.find((p) => p.id === a.id);
    assert(pa.status === "scheduled", `rescheduled post a is ${pa.status} at +90 min, expected scheduled`);
    const base = Date.now();
    for (let i = 0; i < 6; i++) {
      await ok("POST", "/api/cron/tick", { now: new Date(base + 150 * MIN + i * 2 * MIN).toISOString() });
      posts = (await ok("GET", `/api/posts?batchId=${r.batchId}`)).posts;
      if (posts.every((p) => p.status === "published")) break;
    }
    assert(posts.every((p) => p.status === "published"), `scheduled posts not published after clock advance: ${posts.map((p) => p.status)}`);
    assert(posts.find((p) => p.id === b.id).status === "published", "post b not published");
  });

  await step("metrics tick + GET /api/analytics shows non-zero totals for all six providers", async () => {
    const base = Date.now() + 400 * MIN;
    const t = await ok("POST", "/api/cron/tick", { metrics: true, now: new Date(base).toISOString() });
    assert(t.metrics, "no metrics summary returned");
    let a;
    for (const days of [30]) a = await ok("GET", `/api/analytics?days=${days}`);
    assert(a.totals.posts >= 6 && a.totals.views > 0, `analytics totals ${JSON.stringify(a.totals)}`);
    for (const p of PROVIDERS) assert((a.byProvider[p]?.views ?? 0) > 0, `analytics: no views for ${p} (${JSON.stringify(a.byProvider[p])})`);
    log(`   totals: ${a.totals.posts} posts, ${a.totals.views} views, ${a.totals.likes} likes`);
  });

  await step("GET /api/system/status is sane", async () => {
    const s = (await ok("GET", "/api/system/status")).status;
    assert(s.worker.online === true, "worker offline");
    assert(s.ffmpeg.ok && s.storage.files > 0 && s.storage.bytes > 0, `storage/ffmpeg: ${JSON.stringify({ f: s.ffmpeg.ok, st: s.storage })}`);
    assert(path.resolve(s.dataDir) === path.resolve(tmp), `dataDir ${s.dataDir} is not the temp dir`);
    assert(Object.values(s.keys).every((v) => typeof v === "boolean"), "keys must be booleans only (no secret values)");
    log(`   worker online, ${s.storage.files} files / ${(s.storage.bytes / 1e6).toFixed(1)} MB in storage, scorer: ${s.llmScorer}`);
  });

  await step("POST /api/system/delete-all empties projects, posts and storage", async () => {
    const bad = await api("POST", "/api/system/delete-all", { confirm: "nope" });
    assert(bad.status === 400, `delete-all without exact confirmation -> ${bad.status}`);
    sse.abort.abort();
    await ok("POST", "/api/system/delete-all", { confirm: "DELETE" });
    assert((await ok("GET", "/api/projects")).projects.length === 0, "projects not empty");
    assert((await ok("GET", "/api/posts")).posts.length === 0, "posts not empty");
    assert((await ok("GET", "/api/accounts")).accounts.length === 0, "accounts not empty");
    const s = (await ok("GET", "/api/system/status")).status;
    assert(s.storage.files === 0 && s.storage.bytes === 0, `storage not empty: ${JSON.stringify(s.storage)}`);
  });
}

function summary(error) {
  console.log("\n" + "=".repeat(72));
  console.log("KLIPZ e2e summary");
  console.log("=".repeat(72));
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.name}${r.ok ? "" : `\n        -> ${r.error}`}`);
  const failed = results.filter((r) => !r.ok).length;
  const pass = !error && failed === 0;
  console.log("-".repeat(72));
  console.log(`${pass ? "PASS" : "FAIL"}: ${results.length - failed}/${results.length} steps passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (error && !failed) console.log(`error: ${error.message}`);
  return pass;
}

// Ctrl+C / terminal close: still tear down the launcher tree and remove the temp dir (no orphans).
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => {
    try {
      stopLauncher();
      if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    process.exit(130);
  });
}

let fatal = null;
try {
  await main();
} catch (e) {
  fatal = e;
  if (!(e instanceof AssertionError) || /exited early|already in use/.test(e.message)) console.error(e instanceof Error ? e.message : e);
} finally {
  const failedSomething = fatal !== null;
  if (failedSomething && launcherLog) {
    console.log("\n--- last launcher output ---");
    console.log(launcherLog.split("\n").slice(-40).join("\n"));
  }
  stopLauncher();
  await sleep(1500);
  if (!KEEP) {
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await sleep(800);
      }
    }
    log(fs.existsSync(tmp) ? `could not remove ${tmp}` : "temp dir removed");
  } else log(`kept temp dir: ${tmp}`);
  const leftovers = portsFree();
  if (leftovers.length) console.log(`WARNING: port(s) still listening after teardown: ${leftovers.join(", ")}`);
  const pass = summary(fatal);
  process.exit(pass && leftovers.length === 0 ? 0 : 1);
}
