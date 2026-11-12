import fs from "node:fs";
import path from "node:path";
import type { Provider } from "@klipz/shared";
import { decryptToken, encryptToken } from "@klipz/publishers";
import { dataDir } from "../paths";
import { credentialVars, encryptionKey } from "./config";

// Developer-app keys entered on the Accounts page (desktop app: nobody edits .env files there).
// Stored in <data dir>/platform-keys.json keyed by the env variable name they stand in for.
// The client id is public by design; the client secret is AES-256-GCM sealed with the token key.
// Real environment variables / .env.local always win over these.

type Env = Record<string, string | undefined>;

interface StoredKey {
  clientId: string;
  clientSecretEnc: string;
  updatedAt: string;
}

type KeyFile = Record<string, StoredKey>;

const FILE = "platform-keys.json";

/** One storage slot per credential pair: Instagram and Facebook share the Meta app. */
export const keySlot = (provider: Provider): string => credentialVars(provider).id;

function filePath(dir: string = dataDir()): string {
  return path.join(dir, FILE);
}

function readFile(dir?: string): KeyFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath(dir), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as KeyFile) : {};
  } catch {
    return {};
  }
}

function writeFile(data: KeyFile, dir?: string): void {
  const file = filePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function saveAppKeys(provider: Provider, clientId: string, clientSecret: string, opts: { dir?: string; key?: string } = {}): void {
  const data = readFile(opts.dir);
  data[keySlot(provider)] = {
    clientId: clientId.trim(),
    clientSecretEnc: encryptToken(clientSecret.trim(), opts.key ?? encryptionKey()),
    updatedAt: new Date().toISOString(),
  };
  writeFile(data, opts.dir);
}

export function deleteAppKeys(provider: Provider, opts: { dir?: string } = {}): boolean {
  const data = readFile(opts.dir);
  const slot = keySlot(provider);
  if (!data[slot]) return false;
  delete data[slot];
  writeFile(data, opts.dir);
  return true;
}

/**
 * Stored keys as env-style entries ({X_CLIENT_ID, X_CLIENT_SECRET, ...}).
 * An entry that cannot be decrypted (key file replaced) is skipped, so the provider shows "not configured".
 */
export function storedKeyEnv(opts: { dir?: string; key?: string } = {}): Env {
  const data = readFile(opts.dir);
  const out: Env = {};
  let key: string | undefined;
  for (const [idVar, entry] of Object.entries(data)) {
    if (!entry?.clientId || !entry.clientSecretEnc) continue;
    const secretVar = idVar.replace(/_(CLIENT|APP)_ID$/, (_m, kind: string) => `_${kind}_SECRET`);
    if (secretVar === idVar) continue;
    try {
      key ??= opts.key ?? encryptionKey();
      out[secretVar] = decryptToken(entry.clientSecretEnc, key);
      out[idVar] = entry.clientId;
    } catch {
      /* undecryptable: ignore */
    }
  }
  return out;
}

/** process.env with stored app keys filling in what the environment does not set. */
export function effectiveEnv(env: Env = process.env, opts: { dir?: string; key?: string } = {}): Env {
  const stored = storedKeyEnv(opts);
  const merged: Env = { ...env };
  for (const [k, v] of Object.entries(stored)) if (!env[k]?.trim()) merged[k] = v;
  return merged;
}

/** Where a provider's credentials come from right now. */
export function keySource(provider: Provider, env: Env = process.env, opts: { dir?: string } = {}): "env" | "app" | null {
  const vars = credentialVars(provider);
  if (env[vars.id]?.trim() && env[vars.secret]?.trim()) return "env";
  const entry = readFile(opts.dir)[vars.id];
  return entry?.clientId && entry.clientSecretEnc ? "app" : null;
}
