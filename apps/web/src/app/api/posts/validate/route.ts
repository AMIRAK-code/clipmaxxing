import { body, ok, route } from "@/server/http";
import { PostInputSchema, validatePosts } from "@/server/social/posts";

export const dynamic = "force-dynamic";

/** Same body as POST /api/posts, no writes -> {issues, composed} */
export const POST = route(async (req) => ok(validatePosts(await body(req, PostInputSchema))));
