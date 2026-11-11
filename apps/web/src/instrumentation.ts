export async function register(): Promise<void> {
  // Node runtime only (the edge bundle must not see node:sqlite / node:crypto imports).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./server/social/scheduler");
    startScheduler();
  }
}
