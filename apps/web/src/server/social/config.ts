import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PROVIDERS, type Provider } from "@klipz/shared";
import { aggregatorConfigFromEnv, type AggregatorConfig, type ProviderConfig } from "@klipz/publishers";
import { dataDir } from "../paths";

type Env = Record<string, string | undefined>;

/**
 * Read a secret file from the data dir, generating 32 random bytes (base64) on
 * first use. Created exclusive + mode 0600 (best effort on Windows, where the
 * file lives in the user's profile folder anyway).
 */
export function readOrCreateSecretFile(name: string, dir: string = dataDir()): string {
  const file = path.join(dir, name);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* create below */
  }
  const value = randomBytes(32).toString("base64");
  try {
    fs.writeFileSync(file, value + "\n", { flag: "wx", mode: 0o600 });
    return value;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost a race with another process; use whatever won.
      const won = fs.readFileSync(file, "utf8").trim();
      if (won) return won;
      fs.writeFileSync(file, value + "\n", { mode: 0o600 });
      return value;
    }
    throw e;
  }
}

/** AES-256-GCM key for tokens at rest: env TOKEN_ENCRYPTION_KEY or <data dir>/secret.key. */
export function encryptionKey(env: Env = process.env): string {
  return env.TOKEN_ENCRYPTION_KEY?.trim() || readOrCreateSecretFile("secret.key");
}

/** HMAC secret for the OAuth state: env OAUTH_STATE_SECRET or <data dir>/state.key. */
export function stateSecret(env: Env = process.env): string {
  return env.OAUTH_STATE_SECRET?.trim() || readOrCreateSecretFile("state.key");
}

export const sandboxMode = (env: Env = process.env): boolean => /^(1|true|yes|on)$/i.test(env.KLIPZ_PUBLISH_MOCK?.trim() ?? "");

export const appUrl = (env: Env = process.env): string => (env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");

export const redirectUriFor = (provider: Provider, env: Env = process.env): string => `${appUrl(env)}/api/oauth/${provider}/callback`;

export const aggregator = (env: Env = process.env): AggregatorConfig | undefined => aggregatorConfigFromEnv(env);

/** Env variable names that hold the client id / secret of a provider. */
export function credentialVars(provider: Provider): { id: string; secret: string } {
  if (provider === "instagram" || provider === "facebook") return { id: "META_APP_ID", secret: "META_APP_SECRET" };
  const p = provider.toUpperCase();
  return { id: `${p}_CLIENT_ID`, secret: `${p}_CLIENT_SECRET` };
}

/** Optional pass-through settings read by the adapters via config.extra. */
function extras(provider: Provider, env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (k: string, v: string | undefined) => {
    if (v?.trim()) out[k] = v.trim();
  };
  if (provider === "instagram" || provider === "facebook") {
    set("graphVersion", env.META_GRAPH_VERSION);
    set("configId", env.META_CONFIG_ID);
  }
  if (provider === "linkedin") {
    set("linkedinVersion", env.LINKEDIN_VERSION);
    set("linkedinScopes", env.LINKEDIN_EXTRA_SCOPES);
  }
  if (provider === "tiktok") set("tiktokSource", env.TIKTOK_SOURCE);
  set("pollMaxAttempts", env.KLIPZ_POLL_MAX_ATTEMPTS);
  return out;
}

/** Provider config from env, or undefined when the client id / secret are not set. */
export function providerConfig(provider: Provider, env: Env = process.env): ProviderConfig | undefined {
  const vars = credentialVars(provider);
  const clientId = env[vars.id]?.trim();
  const clientSecret = env[vars.secret]?.trim();
  if (!clientId || !clientSecret) return undefined;
  const extra = extras(provider, env);
  return { clientId, clientSecret, redirectUri: redirectUriFor(provider, env), ...(Object.keys(extra).length ? { extra } : {}) };
}

/** Config used for calls that never reach a real platform (sandbox) or go through the aggregator. */
export function configOrPlaceholder(provider: Provider, env: Env = process.env): ProviderConfig {
  return providerConfig(provider, env) ?? { clientId: "", clientSecret: "", redirectUri: redirectUriFor(provider, env), extra: extras(provider, env) };
}

export const routedViaAggregator = (provider: Provider, env: Env = process.env): boolean => {
  const a = aggregator(env);
  return Boolean(a && a.providers.includes(provider));
};

export interface ProviderStatus {
  configured: boolean;
  missing: string[];
  viaAggregator: boolean;
  redirectUri: string;
}

/** Which providers can be connected right now. Never includes secret values. */
export function providerStatus(env: Env = process.env): Record<Provider, ProviderStatus> {
  const out = {} as Record<Provider, ProviderStatus>;
  for (const provider of PROVIDERS) {
    const vars = credentialVars(provider);
    const viaAggregator = routedViaAggregator(provider, env);
    const missing = [vars.id, vars.secret].filter((k) => !env[k]?.trim());
    out[provider] = { configured: viaAggregator || missing.length === 0, missing: viaAggregator ? [] : missing, viaAggregator, redirectUri: redirectUriFor(provider, env) };
  }
  return out;
}
