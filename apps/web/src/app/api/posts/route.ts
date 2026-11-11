import { body, fail, ok, route } from "@/server/http";
import { PostInputSchema, ValidationFailed, createPosts, listPostViews } from "@/server/social/posts";

export const dynamic = "force-dynamic";

/** GET /api/posts?clipId=&batchId=&status=a,b -> {posts: PostView[]} */
export const GET = route((req) => {
  const q = new URL(req.url).searchParams;
  return ok({ posts: listPostViews({ clipId: q.get("clipId") ?? undefined, batchId: q.get("batchId") ?? undefined, status: q.get("status") ?? undefined }) });
});

/** POST /api/posts -> 200 {batchId, posts} | 422 {error, issues: {[accountId]: ValidationIssue[]}} */
export const POST = route(async (req) => {
  const input = await body(req, PostInputSchema);
  try {
    return ok(createPosts(input), { status: 201 });
  } catch (e) {
    if (e instanceof ValidationFailed) return fail(422, "Some platforms reject this post", { issues: e.issues });
    throw e;
  }
});
