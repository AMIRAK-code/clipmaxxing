"use client";

import type { Job } from "@klipz/shared";
import { AlertTriangle, RotateCw, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge, Progress } from "@/components/ui/primitives";
import { JOB_LABEL } from "@/hooks/use-jobs";
import { visibleJobs } from "@/lib/clip-ui";
import { api } from "@/lib/utils";

const ACTIVE = new Set(["queued", "running"]);
const BAD = new Set(["failed", "dead"]);

/**
 * Live rows for pipeline jobs. Shows queued/running/failed/dead jobs; pass
 * `showDone` to include finished ones too. The container is aria-live so screen
 * readers hear progress milestones without being flooded.
 */
export function JobList({ jobs, showDone = false }: { jobs: Job[]; showDone?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = visibleJobs(jobs, showDone);

  async function act(id: string, action: "retry" | "cancel") {
    setBusy(id);
    setError(null);
    try {
      await api(`/api/jobs/${id}`, { method: "POST", json: { action } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div aria-live="polite" aria-relevant="additions text" className="flex flex-col gap-2">
      {rows.map((j) => {
        const bad = BAD.has(j.status);
        const active = ACTIVE.has(j.status);
        const label = JOB_LABEL[j.type] ?? j.type;
        return (
          <div key={j.id} className="rounded-lg border border-line bg-panel-2/60 p-3" data-job-status={j.status}>
            <div className="flex items-center gap-2">
              {bad ? <AlertTriangle className="h-4 w-4 shrink-0 text-bad" aria-hidden /> : null}
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
              {j.status === "queued" ? <Badge>Queued</Badge> : null}
              {j.status === "running" ? (
                <span className="text-xs tabular-nums text-muted">{Math.round(j.progress * 100)}%</span>
              ) : null}
              {bad ? <Badge tone="bad">{j.status === "dead" ? "Gave up" : "Failed"}</Badge> : null}
              {j.status === "succeeded" ? <Badge tone="good">Done</Badge> : null}
              {bad ? (
                <Button size="sm" variant="secondary" disabled={busy === j.id} onClick={() => act(j.id, "retry")} aria-label={`Retry ${label}`}>
                  <RotateCw className="h-3.5 w-3.5" aria-hidden /> Retry
                </Button>
              ) : null}
              {active ? (
                <Button size="iconSm" variant="ghost" disabled={busy === j.id} onClick={() => act(j.id, "cancel")} aria-label={`Cancel ${label}`}>
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              ) : null}
            </div>
            {active ? (
              <div className="mt-2 flex flex-col gap-1">
                <Progress value={j.status === "queued" ? 0 : j.progress} />
                <p className="h-4 truncate text-xs text-muted">{j.status === "queued" ? "Waiting for the worker" : (j.stage ?? "Starting")}</p>
              </div>
            ) : null}
            {bad && j.error ? <p className="mt-2 break-words text-xs text-bad/90">{j.error}</p> : null}
          </div>
        );
      })}
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
