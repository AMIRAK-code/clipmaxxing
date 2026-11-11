#!/usr/bin/env node
// `npm run dev` / `npm run start` in apps/web: next on 127.0.0.1 at KLIPZ_PORT (default 3000),
// the same port rule as scripts/start.mjs. Usage: node scripts/next-port.mjs dev|start
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const mode = process.argv[2] === "start" ? "start" : "dev";
const port = String(Number(process.env.KLIPZ_PORT) || 3000);
process.env.APP_URL ??= `http://localhost:${port}`;
const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [nextBin, mode, "-H", "127.0.0.1", "-p", port], { stdio: "inherit", env: process.env });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
