#!/usr/bin/env node
// Start the Python worker with the venv interpreter, wherever it lives.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const venv = process.env.KLIPZ_VENV || path.join(os.homedir(), ".klipz", "venv");
const candidates = [path.join(venv, "Scripts", "python.exe"), path.join(venv, "bin", "python")];
const python = candidates.find((p) => fs.existsSync(p));
if (!python) {
  console.error(`No Python venv found at ${venv}. Create it with:\n  python -m venv "${venv}"\n  "${candidates[0]}" -m pip install -r apps/worker/requirements.txt`);
  process.exit(1);
}
const mode = process.argv[2] === "test" ? ["-m", "pytest", "-q", ...process.argv.slice(3)] : ["-m", "klipz_worker.main", ...process.argv.slice(2)];
const child = spawn(python, mode, { cwd: path.join(root, "apps", "worker"), stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
