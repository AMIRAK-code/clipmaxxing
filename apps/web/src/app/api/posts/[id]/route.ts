import { body, notFound, ok, route } from "@/server/http";
import { PostActionSchema, applyPostAction, deletePost, getPostView } from "@/server/social/posts";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>((_req, { id }) => ok({ post: getPostView(id) ?? notFound("Post not found") }));

/** {action: 'retry'} | {action: 'cancel'} | {action: 'reschedule', scheduledAt} -> {post}; 409 when the state does not allow it */
export const POST = route<{ id: string }>(async (req, { id }) => {
  const action = await body(req, PostActionSchema);
  applyPostAction(id, action);
  return ok({ post: getPostView(id) });
});

export const DELETE = route<{ id: string }>((_req, { id }) => {
  deletePost(id);
  return ok({ deleted: true });
});
