import { Suspense } from "react";
import { PostsView } from "@/components/posts/posts-view";

export const metadata = { title: "Posts · KLIPZ" };

export default function PostsPage() {
  return (
    <Suspense fallback={null}>
      <PostsView />
    </Suspense>
  );
}
