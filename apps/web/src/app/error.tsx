"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** Global error boundary: shows a calm message and reports the crash to the local log (<data dir>/logs/web.log). */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    void fetch("/api/system/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: `${error.name}: ${error.message}`.slice(0, 2000), digest: error.digest, where: typeof location === "undefined" ? "" : location.pathname }),
    }).catch(() => undefined);
  }, [error]);
  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col items-center gap-3 p-16 text-center">
      <AlertTriangle className="h-10 w-10 text-bad" aria-hidden />
      <h1 className="text-2xl font-black tracking-tight">Something went wrong</h1>
      <p className="text-sm text-muted">This page crashed. The details were saved to the local error log in your KLIPZ data folder (Settings shows the latest entries).</p>
      {error.digest ? <p className="text-xs text-muted">Reference: {error.digest}</p> : null}
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Link href="/" className="inline-flex h-9 items-center rounded-lg border border-line px-4 text-sm font-semibold hover:bg-panel-2">
          Back to projects
        </Link>
      </div>
    </div>
  );
}
