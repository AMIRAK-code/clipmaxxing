import type { Provider } from "@klipz/shared";
import { PROVIDERS } from "@klipz/shared";
import { isPublishError, startConnect, verifyState, type Publisher, type PublisherContext } from "@klipz/publishers";
import { HttpError } from "../http";
import { upsertAccounts, createSandboxAccount } from "./accounts";
import { configOrPlaceholder, providerConfig, redirectUriFor, routedViaAggregator, sandboxMode, stateSecret } from "./config";
import { getPublisherFor } from "./publishers";

export const OAUTH_COOKIE = "klipz_oauth";
export const OAUTH_COOKIE_MAX_AGE = 600;
const WORKSPACE = "local";

export function parseProvider(p: string): Provider {
  if (!(PROVIDERS as string[]).includes(p)) throw new HttpError(404, "Unknown provider");
  return p as Provider;
}

export interface OAuthDeps {
  publisher?: Publisher;
  ctx?: PublisherContext;
  secret?: string;
  now?: () => Date;
  /** Sandbox / aggregator connects create accounts: only a same-origin POST may pass true (never a GET). */
  allowCreate?: boolean;
}

export interface BeginResult {
  /** Where to send the browser (provider auth page, or /accounts for sandbox / aggregator providers). */
  redirectTo: string;
  /** Cookie payload to set (absent when no OAuth round trip is needed). */
  cookieValue?: string;
}

/** Message safe to put in a redirect URL: short, no secrets. */
export function safeMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const cleaned = raw.replace(/(access|refresh)?_?token[=:]\s*\S+/gi, "[redacted]").replace(/[\r\n]+/g, " ");
  return cleaned.slice(0, 160);
}

export const accountsRedirect = (q: Record<string, string>): string => `/accounts?${new URLSearchParams(q).toString()}`;

/** True when connecting creates an account directly (no provider round trip), so it must not happen on a GET. */
export const connectCreatesAccount = (provider: Provider): boolean => sandboxMode() || routedViaAggregator(provider);

export async function beginOAuth(provider: Provider, deps: OAuthDeps = {}): Promise<BeginResult> {
  if (!deps.publisher && !deps.allowCreate && connectCreatesAccount(provider)) {
    // A GET (e.g. a cross-site <img src>) must never create anything: just send the person back to /accounts.
    return { redirectTo: accountsRedirect({ connect: provider }) };
  }
  if (sandboxMode() && !deps.publisher) {
    createSandboxAccount(provider);
    return { redirectTo: accountsRedirect({ connected: provider, n: "1" }) };
  }
  const publisher = deps.publisher ?? getPublisherFor(provider);
  if (!deps.publisher && routedViaAggregator(provider)) {
    // No OAuth: the aggregator holds the platform login. connect() returns a synthetic account.
    const ctx = deps.ctx ?? { config: configOrPlaceholder(provider) };
    const result = await publisher.connect(ctx, { code: "" });
    const accounts = upsertAccounts(provider, result, { viaAggregator: true });
    return { redirectTo: accountsRedirect({ connected: provider, n: String(accounts.length) }) };
  }
  const config = deps.ctx?.config ?? providerConfig(provider);
  if (!config) throw new HttpError(400, `${provider} is not configured`);
  const ctx = deps.ctx ?? { config, ...(deps.now ? { now: deps.now } : {}) };
  const { authUrl, state, codeVerifier } = startConnect(publisher, ctx, { workspaceId: WORKSPACE, stateSecret: deps.secret ?? stateSecret(), ttlSec: OAUTH_COOKIE_MAX_AGE });
  const cookieValue = Buffer.from(JSON.stringify({ state, codeVerifier, provider }), "utf8").toString("base64url");
  return { redirectTo: authUrl, cookieValue };
}

export interface CallbackInput {
  code?: string | null;
  state?: string | null;
  /** provider-sent ?error=... */
  error?: string | null;
  cookieValue?: string | null;
}

/**
 * Finish the OAuth round trip. Returns where to redirect. Never throws: every
 * failure becomes /accounts?error=<short message> (no secrets in the URL).
 */
export async function completeOAuth(provider: Provider, input: CallbackInput, deps: OAuthDeps = {}): Promise<{ redirectTo: string; connected: number }> {
  const fail = (msg: string) => ({ redirectTo: accountsRedirect({ error: msg.slice(0, 160) }), connected: 0 });
  try {
    if (input.error) return fail(`${provider}: ${safeMessage(input.error)}`);
    if (!input.code || !input.state) return fail("Missing code or state in the callback");
    if (!input.cookieValue) return fail("Connect session expired, start again");
    let saved: { state?: unknown; codeVerifier?: unknown; provider?: unknown };
    try {
      saved = JSON.parse(Buffer.from(input.cookieValue, "base64url").toString("utf8")) as typeof saved;
    } catch {
      return fail("Connect session is invalid, start again");
    }
    if (typeof saved.state !== "string" || saved.state !== input.state || saved.provider !== provider) return fail("State mismatch, start again");
    const payload = verifyState(input.state, deps.secret ?? stateSecret(), deps.now ? { now: deps.now } : {});
    if (payload.provider !== provider) return fail("State mismatch, start again");

    const publisher = deps.publisher ?? getPublisherFor(provider);
    const config = deps.ctx?.config ?? providerConfig(provider);
    if (!config) return fail(`${provider} is not configured`);
    const ctx: PublisherContext = deps.ctx ?? { config: { ...config, redirectUri: redirectUriFor(provider) }, ...(deps.now ? { now: deps.now } : {}) };
    const result = await publisher.connect(ctx, {
      code: input.code,
      ...(typeof saved.codeVerifier === "string" ? { codeVerifier: saved.codeVerifier } : {}),
    });
    const accounts = upsertAccounts(provider, result, { viaAggregator: routedViaAggregator(provider) });
    return { redirectTo: accountsRedirect({ connected: provider, n: String(accounts.length) }), connected: accounts.length };
  } catch (e) {
    return fail(isPublishError(e) ? `${provider}: ${safeMessage(e)}` : safeMessage(e));
  }
}
