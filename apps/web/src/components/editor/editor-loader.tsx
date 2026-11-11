"use client";

import dynamic from "next/dynamic";
import type { ClipEditorProps } from "./editor";

// The editor creates ids and measures the DOM on the client, and the player has nothing to
// server-render, so skip SSR entirely (this also avoids hydration mismatches).
const ClipEditor = dynamic(() => import("./editor").then((m) => m.ClipEditor), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg text-sm text-muted" role="status">
      Loading editor…
    </div>
  ),
});

export function ClipEditorLoader(props: ClipEditorProps) {
  return <ClipEditor {...props} />;
}
