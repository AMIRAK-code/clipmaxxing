import type { Job, JobType } from "@klipz/shared";
import { get, newId, nowIso, row, rows, run, tx } from "./db";

export interface EnqueueOpts {
  projectId?: string | null;
  dedupeKey?: string;
  parentJobId?: string;
  maxAttempts?: number;
  runAfter?: string;
}

/**
 * Idempotent enqueue: while a job with the same dedupe key is queued or
 * running, asking again returns that job instead of creating a second one.
 */
export function enqueueJob(type: JobType, payload: Record<string, unknown>, opts: EnqueueOpts = {}): Job {
  return tx(() => {
    if (opts.dedupeKey) {
      const live = row<Job>("jobs", "select * from jobs where dedupe_key = ? and status in ('queued','running')", opts.dedupeKey);
      if (live) return live;
    }
    const id = newId();
    run(
      `insert into jobs (id, project_id, type, payload, dedupe_key, parent_job_id, max_attempts, run_after)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      opts.projectId ?? null,
      type,
      JSON.stringify(payload),
      opts.dedupeKey ?? null,
      opts.parentJobId ?? null,
      opts.maxAttempts ?? 3,
      opts.runAfter ?? nowIso(),
    );
    return row<Job>("jobs", "select * from jobs where id = ?", id)!;
  });
}

export function getJob(id: string): Job | undefined {
  return row<Job>("jobs", "select * from jobs where id = ?", id);
}

export function jobsForProject(projectId: string, limit = 50): Job[] {
  return rows<Job>("jobs", "select * from jobs where project_id = ? order by created_at desc limit ?", projectId, limit);
}

export function jobsChangedSince(sinceIso: string, projectId?: string): Job[] {
  return projectId
    ? rows<Job>("jobs", "select * from jobs where updated_at > ? and project_id = ? order by updated_at", sinceIso, projectId)
    : rows<Job>("jobs", "select * from jobs where updated_at > ? order by updated_at", sinceIso);
}

/** Put a failed/dead job back in the queue with a fresh attempt budget. */
export function retryJob(id: string): boolean {
  const r = run(
    `update jobs set status = 'queued', attempts = 0, error = null, progress = 0, stage = null,
       locked_by = null, heartbeat_at = null, finished_at = null, run_after = ?, updated_at = ?
     where id = ? and status in ('failed','dead','cancelled')`,
    nowIso(),
    nowIso(),
    id,
  );
  return r.changes > 0;
}

export function cancelJob(id: string): boolean {
  const r = run(
    "update jobs set status = 'cancelled', finished_at = ?, updated_at = ? where id = ? and status in ('queued','running')",
    nowIso(),
    nowIso(),
    id,
  );
  return r.changes > 0;
}

export function deadLetterJobs(limit = 100): Job[] {
  return rows<Job>("jobs", "select * from jobs where status in ('dead','failed') order by updated_at desc limit ?", limit);
}

export function workerHeartbeat(): { alive: boolean; lastSeen: string | null } {
  const r = get<{ value: string }>("select value from settings where key = 'worker_heartbeat'");
  if (!r) return { alive: false, lastSeen: null };
  return { alive: Date.now() - Date.parse(r.value) < 15_000, lastSeen: r.value };
}

/** Delete a job row that is no longer queued or running. */
export function deleteFinishedJob(id: string): boolean {
  return run("delete from jobs where id = ? and status not in ('queued','running')", id).changes > 0;
}
