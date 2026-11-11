import { HttpError } from "@/server/http";
import { OAUTH_COOKIE, accountsRedirect, completeOAuth, parseProvider, safeMessage } from "@/server/social/oauth";

export const dynamic = "force-dynamic";

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  const clear = `${OAUTH_COOKIE}=; Path=/api/oauth; Max-Age=0; HttpOnly; SameSite=Lax`;
  let to: string;
  try {
    const provider = parseProvider((await ctx.params).provider);
    const url = new URL(req.url);
    const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const r = await completeOAuth(provider, {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: providerError,
      cookieValue: readCookie(req, OAUTH_COOKIE),
    });
    to = r.redirectTo;
  } catch (e) {
    to = accountsRedirect({ error: e instanceof HttpError ? e.message : safeMessage(e) });
  }
  const headers = new Headers({ Location: to, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clear);
  return new Response(null, { status: 302, headers });
}
