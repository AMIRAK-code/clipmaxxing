import { nowIso } from "@/server/db";
import { jobsChangedSince, workerHeartbeat } from "@/server/jobs";

export const dynamic = "force-dynamic";

/**
 * Server-sent events: pushes every job row that changed (progress, stage,
 * status) plus a worker-online flag. This is the local stand-in for a
 * realtime database subscription.
 */
export async function GET(req: Request): Promise<Response> {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Start slightly in the past so a client never misses a change made while connecting.
      let since = new Date(Date.now() - 2000).toISOString();
      let lastAlive: boolean | null = null;
      let ticks = 0;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const tick = () => {
        if (closed) return;
        try {
          const mark = nowIso();
          const jobs = jobsChangedSince(since, projectId);
          since = jobs.length ? jobs[jobs.length - 1]!.updated_at : since < mark ? since : mark;
          for (const j of jobs) send("job", j);
          const alive = workerHeartbeat().alive;
          if (alive !== lastAlive) {
            lastAlive = alive;
            send("worker", { alive });
          }
          if (++ticks % 30 === 0) send("ping", {});
        } catch (e) {
          send("error", { message: e instanceof Error ? e.message : "poll failed" });
        }
      };
      tick();
      timer = setInterval(tick, 500);
      req.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" },
  });
}
