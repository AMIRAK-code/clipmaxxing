// Tiny loopback static file server with Range support and path-traversal protection.
// Used by render.mjs to expose the storage dir to headless Chrome / the Remotion compositor.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".aac": "audio/aac",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** Resolve a request path to a file strictly inside `root`; null when it escapes or is malformed. */
export function resolveSafe(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rootAbs = path.resolve(root);
  const rel = decoded.replace(/^[/\\]+/, "");
  const full = path.resolve(rootAbs, rel);
  const within = path.relative(rootAbs, full);
  if (within === "" || within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) return null;
  return full;
}

/**
 * Parse a single-range `Range: bytes=a-b` header.
 * Returns {start,end} (inclusive), "unsatisfiable", or null (no / unsupported header -> full body).
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  let start;
  let end;
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

export function createHandler(root) {
  return (req, res) => {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, cors);
      res.end();
      return;
    }
    const file = resolveSafe(root, req.url ?? "/");
    if (!file) {
      res.writeHead(403, cors);
      res.end("forbidden");
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, cors);
        res.end("not found");
        return;
      }
      const range = parseRange(req.headers.range, st.size);
      const base = { ...cors, "Content-Type": contentType(file), "Accept-Ranges": "bytes" };
      if (range === "unsatisfiable") {
        res.writeHead(416, { ...base, "Content-Range": `bytes */${st.size}` });
        res.end();
        return;
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : st.size - 1;
      res.writeHead(range ? 206 : 200, {
        ...base,
        "Content-Length": st.size === 0 ? 0 : end - start + 1,
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${st.size}` } : {}),
      });
      if (req.method === "HEAD" || st.size === 0) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(file, { start, end });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      stream.pipe(res);
    });
  };
}

/** Start serving `root` on 127.0.0.1 (random port by default). */
export function startStaticServer(root, port = 0) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createHandler(root));
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: p,
        origin: `http://127.0.0.1:${p}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Map a (non-absolute) assetBaseUrl onto the storage server. The web editor uses
 * "/api/files/" (route prefix, not a storage folder), which must map to the storage root.
 */
export function assetBaseToServer(origin, assetBaseUrl) {
  const prefix = (assetBaseUrl ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^api\/files(\/|$)/, "")
    .replace(/\/+$/, "");
  return `${origin}/${prefix ? `${prefix.split("/").map(encodeURIComponent).join("/")}/` : ""}`;
}

/** Percent-encode each segment of a storage key and put it below `origin`. */
export function keyToUrl(origin, key) {
  const k = key.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return `${origin}/${k.split("/").map(encodeURIComponent).join("/")}`;
}
