import { NextResponse } from "next/server";
import type { ZodType, ZodTypeDef } from "zod";
import { logError } from "./log";

export const ok = <T>(data: T, init?: ResponseInit) => NextResponse.json(data, init);
export const fail = (status: number, error: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ error, ...extra }, { status });

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function body<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

type Ctx<P> = { params: Promise<P> };

/**
 * Wrap a route handler: maps HttpError to a JSON error, and rejects
 * cross-site requests. The app has no login (it only listens on 127.0.0.1),
 * so the Origin check is what stops other websites open in the same browser
 * from driving it.
 */
export function route<P = Record<string, never>>(fn: (req: Request, params: P) => Promise<Response> | Response) {
  return async (req: Request, ctx: Ctx<P>): Promise<Response> => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
      return await fn(req, await ctx.params);
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message);
      console.error(`[api] ${req.method} ${new URL(req.url).pathname}`, e);
      logError(`api ${req.method} ${new URL(req.url).pathname}`, e);
      return fail(500, e instanceof Error ? e.message : "Internal error");
    }
  };
}

/** Host names the app is legitimately reached under (it only listens on loopback). */
export function allowedHostnames(env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set(["localhost", "127.0.0.1", "[::1]"]);
  try {
    if (env.APP_URL) out.add(new URL(env.APP_URL).hostname);
  } catch {
    /* ignore bad APP_URL */
  }
  return out;
}

export function assertSameOrigin(req: Request): void {
  // DNS-rebinding guard: a page on evil.example resolving to 127.0.0.1 would send a matching
  // Origin and Host, so also require the Host to be a loopback / configured name.
  const hostHeader = req.headers.get("host");
  if (hostHeader) {
    const hostname = hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0]!;
    const h = hostname.toLowerCase();
    if (!allowedHostnames().has(h) && !h.endsWith(".localhost")) throw new HttpError(403, "Unexpected Host header");
  }
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw new HttpError(403, "Cross-site request blocked");
  if (origin) {
    const host = req.headers.get("host");
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    if (!host || originHost !== host) throw new HttpError(403, "Cross-site request blocked");
  }
}

export function notFound(what = "Not found"): never {
  throw new HttpError(404, what);
}
