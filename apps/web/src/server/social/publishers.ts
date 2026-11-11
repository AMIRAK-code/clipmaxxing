import type { Provider } from "@klipz/shared";
import { getPublisher, type Publisher, type PublisherContext } from "@klipz/publishers";
import { aggregator, configOrPlaceholder, sandboxMode } from "./config";
import { mockPublisher } from "./mock";

/** The publisher to use right now: sandbox mock, aggregator-routed, or the native adapter. */
export function getPublisherFor(provider: Provider, env: Record<string, string | undefined> = process.env): Publisher {
  if (sandboxMode(env)) return mockPublisher(provider);
  const agg = aggregator(env);
  return getPublisher(provider, agg ? { aggregator: agg } : {});
}

export function contextFor(provider: Provider, now?: () => Date, env: Record<string, string | undefined> = process.env): PublisherContext {
  return { config: configOrPlaceholder(provider, env), ...(now ? { now } : {}) };
}
