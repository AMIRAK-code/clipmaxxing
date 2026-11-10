"use client";

import type { Job } from "@klipz/shared";
import { useEffect, useRef, useState } from "react";

export interface LiveJobs {
  jobs: Job[];
  workerAlive: boolean | null;
}

const TERMINAL = new Set(["succeeded", "failed", "dead", "cancelled"]);

/**
 * Live job rows for a project (or everything) over SSE. `onFinished` fires
 * once per job when it reaches a terminal state so pages can refetch data.
 */
export function useJobs(projectId: string | undefined, initial: Job[] = [], onFinished?: (job: Job) => void): LiveJobs {
  const [jobs, setJobs] = useState<Job[]>(initial);
  const [workerAlive, setWorkerAlive] = useState<boolean | null>(null);
  const cb = useRef(onFinished);
  cb.current = onFinished;
  const done = useRef(new Set<string>(initial.filter((j) => TERMINAL.has(j.status)).map((j) => j.id)));

  useEffect(() => {
    const es = new EventSource(`/api/events${projectId ? `?projectId=${projectId}` : ""}`);
    es.addEventListener("job", (e) => {
      const job = JSON.parse((e as MessageEvent<string>).data) as Job;
      setJobs((prev) => {
        const i = prev.findIndex((j) => j.id === job.id);
        if (i === -1) return [job, ...prev];
        const next = prev.slice();
        next[i] = job;
        return next;
      });
      const terminal = TERMINAL.has(job.status);
      if (terminal && !done.current.has(job.id)) {
        done.current.add(job.id);
        cb.current?.(job);
      }
      if (!terminal) done.current.delete(job.id);
    });
    es.addEventListener("worker", (e) => setWorkerAlive((JSON.parse((e as MessageEvent<string>).data) as { alive: boolean }).alive));
    return () => es.close();
  }, [projectId]);

  return { jobs, workerAlive };
}

export const JOB_LABEL: Record<string, string> = {
  import_youtube: "Importing from YouTube",
  ingest: "Preparing video",
  transcribe: "Transcribing",
  analyze: "Finding viral moments",
  reframe: "Reframing to 9:16",
  render: "Rendering",
  autoclip: "AutoClip",
  voiceover: "Generating voiceover",
  cleanup: "Cleaning up",
};
