import { HttpError } from "@/server/http";
import { OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE, accountsRedirect, beginOAuth, parseProvider, safeMessage } from "@/server/social/oauth";

export const dynamic = "force-dynamic";

function redirect(to: string, cookie?: string): Response {
  const headers = new Headers({ Location: to, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

// Top-level browser navigation (GET): no Origin header to check. The OAuth
// state is bound to a httpOnly cookie, which is what protects the callback.
export async function GET(_req: Request, ctx: { params: Promise<{ provider: string }> }): Promise<Response> {
  try {
    const provider = parseProvider((await ctx.params).provider);
    const r = await beginOAuth(provider);
    const cookie = r.cookieValue
      ? `${OAUTH_COOKIE}=${r.cookieValue}; Path=/api/oauth; Max-Age=${OAUTH_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`
      : undefined;
    return redirect(r.redirectTo, cookie);
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : safeMessage(e);
    return redirect(accountsRedirect({ error: msg }));
  }
}
