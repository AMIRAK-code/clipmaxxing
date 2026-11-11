#!/usr/bin/env node
// One-command launcher: web app + Python worker as child processes, prefixed coloured logs,
// prerequisite checks, and a clean shutdown of BOTH process trees (taskkill /T /F on Windows).
//
//   npm start                 production (next start; builds first if there is no build yet)
//   npm run klipz             same
//   node scripts/start.mjs --dev      next dev instead
//   --no-build                fail instead of building when the production build is missing
//
// Env: KLIPZ_PORT (web, default 3000), KLIPZ_WORKER_PORT (default 8787), KLIPZ_VENV, KLIPZ_DATA_DIR and
// every other KLIPZ_* / WHISPER_* / API key variable is passed through to both children.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(root, "apps", "web");
const workerDir = path.join(root, "apps", "worker");
const isWin = process.platform === "win32";

const COLORS = { web: "\x1b[36m", worker: "\x1b[35m", klipz: "\x1b[32m", err: "\x1b[31m", warn: "\x1b[33m", off: "\x1b[0m" };
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? `${c}${s}${COLORS.off}` : s);

export function parseArgs(argv) {
  return { dev: argv.includes("--dev"), noBuild: argv.includes("--no-build"), help: argv.includes("--help") || argv.includes("-h") };
}

export function venvPython(env = process.env) {
  const venv = env.KLIPZ_VENV || path.join(os.homedir(), ".klipz", "venv");
  const candidates = [path.join(venv, "Scripts", "python.exe"), path.join(venv, "bin", "python")];
  return { venv, python: candidates.find((p) => fs.existsSync(p)) ?? null, candidates };
}

/** Returns a list of {level:'error'|'warn', message} problems. Pure enough to unit test. */
export async function checkPrereqs({ dev, noBuild }, env = process.env) {
  const problems = [];
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) problems.push({ level: "error", message: `Node ${process.versions.node} is too old. Install Node 20 or newer from https://nodejs.org (LTS).` });

  const { venv, python, candidates } = venvPython(env);
  if (!python) {
    problems.push({
      level: "error",
      message: `Python worker environment not found at ${venv}.\n    Create it with:  python -m venv "${venv}"\n    then:            "${candidates[0]}" -m pip install -r apps/worker/requirements.txt\n    (set KLIPZ_VENV if it lives somewhere else)`,
    });
  }

  try {
    const { FONT_COPY } = await import(pathToFileURL(path.join(root, "scripts", "copy-fonts.mjs")).href);
    const missing = Object.keys(FONT_COPY).filter((f) => !fs.existsSync(path.join(webDir, "public", "fonts", f)));
    if (missing.length) problems.push({ level: "error", message: `Caption fonts are missing (${missing.length} of ${Object.keys(FONT_COPY).length}: ${missing.join(", ")}).\n    Run:  npm run fonts` });
  } catch (e) {
    problems.push({ level: "warn", message: `Could not check fonts: ${e instanceof Error ? e.message : e}` });
  }

  const nextBin = resolveNext();
  if (!nextBin) problems.push({ level: "error", message: "Dependencies are not installed (next not found). Run:  npm install" });

  if (!dev && !fs.existsSync(path.join(webDir, ".next", "BUILD_ID"))) {
    if (noBuild) problems.push({ level: "error", message: "No production build found (apps/web/.next). Run:  npm run build   (or start without --no-build)" });
  }
  return problems;
}

function resolveNext() {
  try {
    return createRequire(path.join(webDir, "package.json")).resolve("next/dist/bin/next");
  } catch {
    return null;
  }
}

/** Kill a child and everything it started (ffmpeg, chrome, python threads' subprocesses ...). */
export function killTree(child) {
  if (!child || child.pid == null || child.exitCode !== null) return;
  try {
    if (isWin) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function pipeLines(stream, prefix, color, sink) {
  let buf = "";
  const tag = paint(color, prefix.padEnd(7) + "|");
  stream.setEncoding("utf8");
  stream.on("data", (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const l of lines) sink.write(`${tag} ${l}\n`);
  });
  stream.on("end", () => {
    if (buf) sink.write(`${tag} ${buf}\n`);
  });
}

function spawnChild(name, color, cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !isWin });
  pipeLines(child.stdout, name, color, process.stdout);
  pipeLines(child.stderr, name, color, process.stdout);
  return child;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/start.mjs [--dev] [--no-build]\n  default = production (builds first if needed); --dev = next dev");
    return 0;
  }
  const log = (m) => console.log(`${paint(COLORS.klipz, "klipz  |")} ${m}`);
  const problems = await checkPrereqs(args);
  for (const p of problems) console.error(`${paint(p.level === "error" ? COLORS.err : COLORS.warn, p.level === "error" ? "ERROR" : "WARN ")} ${p.message}`);
  if (problems.some((p) => p.level === "error")) {
    console.error("\nFix the problem(s) above and run again.");
    return 2;
  }

  const port = String(Number(process.env.KLIPZ_PORT) || 3000);
  const workerPort = String(Number(process.env.KLIPZ_WORKER_PORT) || 8787);
  const env = { ...process.env, KLIPZ_PORT: port, KLIPZ_WORKER_PORT: workerPort, FORCE_COLOR: "1" };
  env.APP_URL ??= `http://localhost:${port}`;
  const nextBin = resolveNext();
  const { python } = venvPython(env);

  if (!args.dev && !fs.existsSync(path.join(webDir, ".next", "BUILD_ID"))) {
    log("No production build yet: running next build (a minute or two) ...");
    const build = spawnChild("build", COLORS.warn, process.execPath, [nextBin, "build"], { cwd: webDir, env });
    const code = await new Promise((res) => build.on("exit", (c) => res(c ?? 1)));
    if (code !== 0) {
      console.error(`${paint(COLORS.err, "ERROR")} next build failed (exit ${code}). Fix the errors above, or use: npm run klipz -- --dev`);
      return 1;
    }
  }

  let shuttingDown = false;
  let exitCode = 0;
  const children = {};
  const done = new Promise((resolve) => {
    const stopAll = (reason, code) => {
      if (shuttingDown) return;
      shuttingDown = true;
      exitCode = code;
      log(`${reason}: stopping web app and worker ...`);
      for (const c of Object.values(children)) killTree(c);
      setTimeout(resolve, 300);
    };
    const watch = (name, child) => {
      child.on("error", (e) => stopAll(`${name} failed to start (${e.message})`, 1));
      child.on("exit", (code, sig) => {
        if (shuttingDown) return;
        stopAll(`${name} exited (${sig ?? code})`, typeof code === "number" && code > 0 && code < 256 ? code : 1); // either child dying is a failure: the app is half-dead
      });
    };
    children.worker = spawnChild("worker", COLORS.worker, python, ["-u", "-m", "klipz_worker.main", "--port", workerPort], { cwd: workerDir, env: { ...env, PYTHONUNBUFFERED: "1" } });
    children.web = spawnChild("web", COLORS.web, process.execPath, [nextBin, args.dev ? "dev" : "start", "-H", "127.0.0.1", "-p", port], { cwd: webDir, env });
    watch("worker", children.worker);
    watch("web", children.web);
    for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) process.on(sig, () => stopAll(`Received ${sig}`, 0));
  });

  log(`KLIPZ (${args.dev ? "dev" : "production"}) starting. Open  ${paint(COLORS.klipz, `http://localhost:${port}`)}   (Ctrl+C stops everything)`);
  await done;
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
