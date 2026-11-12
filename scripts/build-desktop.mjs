#!/usr/bin/env node
// Build the KLIPZ Windows desktop app and its installer.
//
//   npm run desktop:installer     web build + .NET shell + staged app + Inno Setup  -> dist/desktop/KLIPZ-Setup-<ver>.exe
//   npm run desktop:stage         everything except the installer (run dist/desktop/stage/KLIPZ.exe directly)
//
// Needs: Node 22.5+ (bundled as the app's runtime), the .NET 10 SDK, and Inno Setup 6 for the installer
// (winget install -e --id JRSoftware.InnoSetup).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "desktop");
const stage = path.join(out, "stage");
const appDir = path.join(stage, "app");
const stageOnly = process.argv.includes("--stage-only");
const skipWebBuild = process.argv.includes("--skip-web-build");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

const log = (m) => console.log(`\x1b[32mdesktop |\x1b[0m ${m}`);
function sh(cmd, args, opts = {}) {
  log(`${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && !path.isAbsolute(cmd), ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status ?? r.signal})`);
}

/** Copy a directory, skipping names in `skip` (matched against path relative to `from`, forward slashes). */
function copyDir(from, to, skip = () => false) {
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(from, src).split(path.sep).join("/");
      return rel === "" || !skip(rel);
    },
  });
}

const major = Number(process.versions.node.split(".")[0]);
const minor = Number(process.versions.node.split(".")[1]);
if (major < 22 || (major === 22 && minor < 5)) throw new Error("Build with Node 22.5 or newer: it becomes the app's bundled runtime and node:sqlite is required.");

// 1. Web production build (in the dev tree; .next is copied below).
if (!skipWebBuild) sh("npm", ["run", "build"], { cwd: root });
if (!fs.existsSync(path.join(root, "apps", "web", ".next", "BUILD_ID"))) throw new Error("apps/web/.next is missing: the web build did not run.");

// 2. Fresh stage.
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

// 3. .NET shell (self-contained: no .NET runtime needed on the target PC).
sh("dotnet", ["publish", path.join(root, "apps", "desktop", "KlipzDesktop.csproj"), "-c", "Release", "-r", "win-x64", "--self-contained", "true", "-p:PublishReadyToRun=false", "-o", stage]);

// 4. Node runtime.
fs.mkdirSync(path.join(stage, "runtime", "node"), { recursive: true });
fs.copyFileSync(process.execPath, path.join(stage, "runtime", "node", "node.exe"));
log(`bundled node ${process.version}`);

// 5. App code: only what runs. node_modules is installed fresh (production only, real folders instead of
// workspace junctions that would point back into this repo).
for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(root, f), path.join(appDir, f));
copyDir(path.join(root, "db"), path.join(appDir, "db"));
copyDir(path.join(root, "packages"), path.join(appDir, "packages"), (rel) => /(^|\/)node_modules(\/|$)|\.test\.ts$|(^|\/)testing(\/|$)/.test(rel));
copyDir(path.join(root, "apps", "worker"), path.join(appDir, "apps", "worker"), (rel) => /(^|\/)(tests|__pycache__|\.pytest_cache)(\/|$)|^pytest\.ini$|\.pyc$/.test(rel));
copyDir(path.join(root, "apps", "web"), path.join(appDir, "apps", "web"), (rel) => /^\.next\/cache(\/|$)|(^|\/)node_modules(\/|$)|\.test\.tsx?$|^\.env/.test(rel));

sh("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: appDir });

// npm links workspaces with junctions that hold ABSOLUTE paths (they would point into dist/ after install).
// Replace them with real copies; @klipz/web is the app itself and is not imported by anything.
const scope = path.join(appDir, "node_modules", "@klipz");
for (const name of fs.readdirSync(scope)) {
  const link = path.join(scope, name);
  if (!fs.lstatSync(link).isSymbolicLink()) continue;
  const target = path.resolve(scope, fs.readlinkSync(link));
  fs.rmSync(link, { recursive: false, force: true });
  if (name !== "web") copyDir(target, link, (rel) => /(^|\/)node_modules(\/|$)/.test(rel));
}

// Sanity: no symlink/junction may remain in node_modules.
(function checkLinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`Link left in the stage: ${p} -> ${fs.readlinkSync(p)}`);
    if (e.isDirectory()) checkLinks(p);
  }
})(path.join(appDir, "node_modules"));

const size = (d) => {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    n += e.isDirectory() ? size(p) : e.isFile() ? fs.statSync(p).size : 0;
  }
  return n;
};
log(`stage ready: ${stage} (${(size(stage) / 1024 ** 2).toFixed(0)} MB)`);
if (stageOnly) process.exit(0);

// 6. Installer.
const iscc = [
  process.env.ISCC,
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs", "Inno Setup 6", "ISCC.exe"),
].find((p) => p && fs.existsSync(p));
if (!iscc) {
  console.error("\nInno Setup 6 was not found. Install it, then run this again:\n  winget install -e --id JRSoftware.InnoSetup\n(or set ISCC to the full path of ISCC.exe). The staged app in dist/desktop/stage runs without it.");
  process.exit(3);
}
sh(iscc, [`/DAppVersion=${version}`, `/DStageDir=${stage}`, path.join(root, "installer", "klipz.iss")]);
log(`installer: ${path.join(out, `KLIPZ-Setup-${version}.exe`)}`);
