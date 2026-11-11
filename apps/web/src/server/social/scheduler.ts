import { processDuePosts } from "./engine";
import { pullMetrics } from "./metrics";

/**
 * In-process scheduler, started once from instrumentation.ts. Scheduled posts
 * only go out while the KLIPZ web app is running (there is no background
 * service). Missed schedules are published on the next start-up tick.
 */
export const TICK_MS = 15_000;
export const METRICS_MS = 60 * 60 * 1000;

interface State {
  started: boolean;
  tick?: ReturnType<typeof setInterval>;
  metrics?: ReturnType<typeof setInterval>;
  inflight: number;
}
const g = globalThis as unknown as { __klipzScheduler?: State };

export function startScheduler(): boolean {
  if (g.__klipzScheduler?.started) return false; // survives dev hot reloads
  const state: State = (g.__klipzScheduler = { started: true, inflight: 0 });

  const tick = async (): Promise<void> => {
    if (state.inflight >= 3) return;
    state.inflight++;
    try {
      await processDuePosts(new Date());
    } catch (e) {
      console.error("[scheduler] tick failed", e);
    } finally {
      state.inflight--;
    }
  };
  const metrics = async (): Promise<void> => {
    try {
      await pullMetrics(new Date());
    } catch (e) {
      console.error("[scheduler] metrics failed", e);
    }
  };

  state.tick = setInterval(() => void tick(), TICK_MS);
  state.metrics = setInterval(() => void metrics(), METRICS_MS);
  state.tick.unref?.();
  state.metrics.unref?.();
  setTimeout(() => void tick(), 3000).unref?.();
  setTimeout(() => void metrics(), 30_000).unref?.();
  console.log("[scheduler] started: publish tick every 15 s, metrics hourly (scheduled posts only go out while the app runs)");
  return true;
}

export function stopScheduler(): void {
  const s = g.__klipzScheduler;
  if (!s) return;
  if (s.tick) clearInterval(s.tick);
  if (s.metrics) clearInterval(s.metrics);
  g.__klipzScheduler = undefined;
}
