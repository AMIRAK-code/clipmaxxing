#!/usr/bin/env node
// Build the Remotion composition bundle once, at packaging time:  node scripts/prebuild-remotion.mjs <outDir>
// The installed desktop app ships this folder as packages/video/prebuilt and renders from it directly.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "packages", "video", "prebuilt"));
const require = createRequire(path.join(root, "packages", "video", "package.json"));
const { bundle } = require("@remotion/bundler");

fs.rmSync(outDir, { recursive: true, force: true });
await bundle({
  entryPoint: path.join(root, "packages", "video", "src", "entry.ts"),
  outDir,
  publicDir: path.join(root, "apps", "web", "public"),
  rootDir: root,
});
if (!fs.existsSync(path.join(outDir, "index.html"))) throw new Error("Remotion bundle has no index.html");
console.log(`remotion bundle: ${outDir}`);
