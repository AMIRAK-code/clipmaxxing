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

// 5. App code: only what runs.
const web = path.join(root, "apps", "web");
const standalone = path.join(web, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, "apps", "web", "server.js"))) throw new Error("apps/web/.next/standalone is missing: next.config.ts must set output: \"standalone\".");
// 5a. Web: Next's self-contained server (traced files only) + static assets + public.
copyDir(standalone, appDir, (rel) => /(^|\/)\.env/.test(rel));
copyDir(path.join(web, ".next", "static"), path.join(appDir, "apps", "web", ".next", "static"));
copyDir(path.join(web, "public"), path.join(appDir, "apps", "web", "public"));
// 5b. Database migrations and the Python worker.
copyDir(path.join(root, "db"), path.join(appDir, "db"));
copyDir(path.join(root, "apps", "worker"), path.join(appDir, "apps", "worker"), (rel) => /(^|\/)(tests|__pycache__|\.pytest_cache)(\/|$)|^pytest\.ini$|\.pyc$/.test(rel));
// 5c. Renderer: render.mjs + a Remotion bundle built now (no webpack/bundler in the installed app).
const videoOut = path.join(appDir, "packages", "video");
fs.mkdirSync(videoOut, { recursive: true });
for (const f of ["render.mjs", "package.json"]) fs.copyFileSync(path.join(root, "packages", "video", f), path.join(videoOut, f));
copyDir(path.join(root, "packages", "video", "lib"), path.join(videoOut, "lib"));
sh(process.execPath, [path.join(root, "scripts", "prebuild-remotion.mjs"), path.join(videoOut, "prebuilt")]);
// 5d. node_modules for render.mjs: the dependency closure of @remotion/renderer, copied from this tree.
(function copyClosure(entry) {
  const nm = path.join(root, "node_modules");
  const seen = new Set();
  const resolveDep = (fromDir, name) => {
    for (let dir = fromDir; dir.startsWith(nm); dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
      if (dir === nm) break;
    }
    const top = path.join(nm, name);
    return fs.existsSync(path.join(top, "package.json")) ? top : null;
  };
  const visit = (pkgDir) => {
    if (seen.has(pkgDir)) return;
    seen.add(pkgDir);
    const dest = path.join(appDir, "node_modules", path.relative(nm, pkgDir));
    if (!fs.existsSync(path.join(dest, "package.json"))) copyDir(pkgDir, dest, (rel) => /^node_modules(\/|$)/.test(rel));
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    for (const [name, optional] of [...Object.keys(pj.dependencies ?? {}).map((n) => [n, false]), ...Object.keys(pj.optionalDependencies ?? {}).map((n) => [n, true])]) {
      const dep = resolveDep(pkgDir, name);
      if (dep) visit(dep);
      else if (!optional) throw new Error(`Cannot resolve ${name} (needed by ${pkgDir})`);
    }
  };
  visit(path.join(nm, ...entry.split("/")));
  log(`renderer closure: ${seen.size} packages`);
})("@remotion/renderer");

// Sanity: no symlink/junction may remain (npm workspace junctions hold absolute paths into this repo).
(function checkLinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`Link left in the stage: ${p} -> ${fs.readlinkSync(p)}`);
    if (e.isDirectory()) checkLinks(p);
  }
})(appDir);

const size = (d) => {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    n += e.isDirectory() ? size(p) : e.isFile() ? fs.statSync(p).size : 0;
  }
  return n;
};
const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
log(`stage ready: ${stage} (${(size(stage) / 1024 ** 2).toFixed(0)} MB, ${count(stage)} files)`);
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
