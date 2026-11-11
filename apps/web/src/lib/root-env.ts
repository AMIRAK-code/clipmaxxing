import fs from "node:fs";
import path from "node:path";

type Env = Record<string, string | undefined>;

/** Parse the subset of dotenv syntax the app uses: KEY=value, export, quotes, trailing comments, # lines. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) {
      const end = v.indexOf(q, 1);
      v = v.slice(1, end);
      if (q === '"') v = v.replace(/\n/g, "\n");
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]!] = v;
  }
  return out;
}

/**
 * Load <root>/.env.local then <root>/.env into env WITHOUT overriding anything already set
 * (real environment variables and apps/web/.env.local, which Next loads first, both win).
 * Returns the names that were added.
 */
export function loadRootEnv(root: string, env: Env = process.env): string[] {
  const added: string[] = [];
  for (const name of [".env.local", ".env"]) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, name), "utf8");
    } catch {
      continue;
    }
    for (const [k, v] of Object.entries(parseEnvFile(text))) {
      if (env[k] === undefined) {
        env[k] = v;
        added.push(k);
      }
    }
  }
  return added;
}
