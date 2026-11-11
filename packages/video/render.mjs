#!/usr/bin/env node
// KLIPZ render CLI (used by the Python worker).
//   node packages/video/render.mjs --props props.json --out out.mp4 [--storage DIR]
//        [--concurrency N] [--cover cover.jpg --cover-frame N]
// stdout: one JSON object per line:
//   {"type":"progress","progress":0..1,"stage":"bundling"|"rendering"|"encoding"}
//   {"type":"done","out":"...","frames":N[,"cover":"..."]}   |   {"type":"error","message":"..."} (exit 1)
// Everything else (library logging) goes to stderr.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "./lib/bundle-cache.mjs";
import { assetBaseToServer, keyToUrl, startStaticServer } from "./lib/static-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const PUBLIC_DIR = path.join(repoRoot, "apps", "web", "public");
const COMPOSITION_ID = "Clip";

// keep stdout clean for the JSON protocol
const realLog = console.log;
console.log = (...a) => console.error(...a);
console.info = (...a) => console.error(...a);

function emit(obj, cb) {
  process.stdout.write(`${JSON.stringify(obj)}\n`, cb);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    a[k.slice(2)] = v;
  }
  return a;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

/** Hash of the mtimes+sizes of the composition sources, shared sources and fonts. */
export function sourceHash() {
  const h = crypto.createHash("sha1");
  const dirs = [path.join(here, "src"), path.join(repoRoot, "packages", "shared", "src"), path.join(PUBLIC_DIR, "fonts")];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of walk(d).sort()) {
      const st = fs.statSync(f);
      h.update(`${path.relative(repoRoot, f)}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
    }
  }
  h.update("remotion-4.0.542");
  return h.digest("hex").slice(0, 16);
}

async function getBundle(cacheRoot) {
  const { bundle } = await import("@remotion/bundler");
  return ensureBundle(cacheRoot, sourceHash(), async (outDir) => {
    emit({ type: "progress", progress: 0, stage: "bundling" });
    let last = -1;
    await bundle({
      entryPoint: path.join(here, "src", "entry.ts"),
      outDir,
      publicDir: PUBLIC_DIR,
      rootDir: repoRoot,
      onProgress: (p) => {
        const q = Math.floor(p / 5);
        if (q !== last) {
          last = q;
          emit({ type: "progress", progress: Math.min(1, p / 100) * 0.1, stage: "bundling" });
        }
      },
    });
  });
}

export function isTransient(err) {
  return /No frame found at position|Compositor error/i.test(err instanceof Error ? err.message : String(err));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.props || !args.out) throw new Error("usage: render.mjs --props <props.json> --out <out.mp4> [--storage <dir>] [--concurrency N] [--cover <jpg> --cover-frame N]");
  const props = JSON.parse(fs.readFileSync(args.props, "utf8"));
  if (!props.sourceUrl) throw new Error("props.sourceUrl is required");
  if (!props.edit && !props.clip) throw new Error("props need `edit` or `clip`");

  const storage = args.storage ? path.resolve(args.storage) : null;
  const cacheRoot = path.join(storage ? path.resolve(storage, "..", "cache") : path.join(os.tmpdir(), "klipz-cache"), "remotion-bundle");

  let server = null;
  try {
    const isAbs = (s) => /^(https?:|data:|blob:)/i.test(s);
    if (storage) {
      server = await startStaticServer(storage);
      if (!isAbs(props.sourceUrl)) props.sourceUrl = keyToUrl(server.origin, props.sourceUrl);
      if (!isAbs(props.assetBaseUrl ?? "")) {
        props.assetBaseUrl = assetBaseToServer(server.origin, props.assetBaseUrl ?? "");
      }
    }
    if (!isAbs(props.sourceUrl)) throw new Error("sourceUrl is not absolute and no --storage dir was given");
    props.showSafeZone = false;
    props.assetBaseUrl = props.assetBaseUrl ?? "";

    const serveUrl = await getBundle(cacheRoot);

    const { renderMedia, renderStill, selectComposition } = await import("@remotion/renderer");
    emit({ type: "progress", progress: 0.1, stage: "rendering" });
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps: props, logLevel: "error" });
    const total = composition.durationInFrames;

    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    let lastPct = -1;
    // the compositor occasionally reports a transient "No frame found" under heavy machine load
    for (let attempt = 1; ; attempt++) {
      lastPct = -1;
      try {
        await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      audioCodec: "aac",
      crf: 18,
      pixelFormat: "yuv420p",
      // jpeg frames would be tagged yuvj420p (full range); png keeps standard yuv420p
      imageFormat: "png",
      colorSpace: "bt709",
      outputLocation: path.resolve(args.out),
      inputProps: props,
      concurrency: args.concurrency ? Number(args.concurrency) : undefined,
      logLevel: "error",
      overwrite: true,
      onProgress: (p) => {
        const stage = p.renderedFrames >= total ? "encoding" : "rendering";
        const pct = Math.floor(p.progress * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          emit({ type: "progress", progress: 0.1 + 0.9 * p.progress, stage });
        }
      },
        });
        break;
      } catch (err) {
        if (attempt >= 2 || !isTransient(err)) throw err;
        console.error("[render] transient compositor error, retrying");
      }
    }

    let cover;
    if (args.cover) {
      const frame = Math.min(total - 1, Math.max(0, Number(args["cover-frame"] ?? 0) || 0));
      await renderStill({
        composition,
        serveUrl,
        output: path.resolve(args.cover),
        frame,
        imageFormat: "jpeg",
        jpegQuality: 92,
        inputProps: props,
        logLevel: "error",
        overwrite: true,
      });
      cover = path.resolve(args.cover);
    }
    emit({ type: "progress", progress: 1, stage: "encoding" });
    emit({ type: "done", out: path.resolve(args.out), frames: total, ...(cover ? { cover } : {}) });
  } finally {
    if (server) await server.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // exit from the write callback so the final JSON line is flushed even on a pipe
  main().then(
    () => process.stdout.write("", () => process.exit(0)),
    (err) => {
      emit({ type: "error", message: err instanceof Error ? err.message : String(err) }, () => process.exit(1));
    },
  );
}
void realLog;
