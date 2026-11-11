import { createAggregatorPublisher } from './aggregator';
import { facebookPublisher } from './providers/facebook';
import { instagramPublisher } from './providers/instagram';
import { linkedinPublisher } from './providers/linkedin';
import { tiktokPublisher } from './providers/tiktok';
import { xPublisher } from './providers/x';
import { youtubePublisher } from './providers/youtube';
import type { AggregatorConfig, Provider, Publisher } from './types';

const NATIVE: Record<Provider, Publisher> = {
  youtube: youtubePublisher,
  tiktok: tiktokPublisher,
  instagram: instagramPublisher,
  facebook: facebookPublisher,
  x: xPublisher,
  linkedin: linkedinPublisher,
};

/** Native adapter for a provider (never aggregator-backed). */
export function getNativePublisher(provider: Provider): Publisher {
  const publisher = NATIVE[provider];
  if (!publisher) throw new Error(`Unknown provider: ${String(provider)}`);
  return publisher;
}

/**
 * Publisher for a provider. When an aggregator config is passed and routes this provider,
 * the returned publisher delegates publish/status/metrics to the aggregator.
 */
export function getPublisher(provider: Provider, opts: { aggregator?: AggregatorConfig } = {}): Publisher {
  const native = getNativePublisher(provider);
  const aggregator = opts.aggregator;
  if (aggregator && aggregator.apiKey && aggregator.providers.includes(provider)) {
    return createAggregatorPublisher(provider, aggregator, native);
  }
  return native;
}

/** Build an AggregatorConfig from the documented env values (AGGREGATOR_KIND / _API_KEY / _PROVIDERS). */
export function aggregatorConfigFromEnv(env: {
  AGGREGATOR_KIND?: string | undefined;
  AGGREGATOR_API_KEY?: string | undefined;
  AGGREGATOR_PROVIDERS?: string | undefined;
  AGGREGATOR_PROFILE_KEY?: string | undefined;
  AGGREGATOR_BASE_URL?: string | undefined;
}): AggregatorConfig | undefined {
  const kind = env.AGGREGATOR_KIND?.trim();
  const apiKey = env.AGGREGATOR_API_KEY?.trim();
  if ((kind !== 'upload-post' && kind !== 'ayrshare') || !apiKey) return undefined;
  const all = Object.keys(NATIVE) as Provider[];
  const providers = (env.AGGREGATOR_PROVIDERS ?? '')
    .split(/[\s,]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is Provider => (all as string[]).includes(p));
  const config: AggregatorConfig = { kind, apiKey, providers };
  if (env.AGGREGATOR_PROFILE_KEY?.trim()) config.profileKey = env.AGGREGATOR_PROFILE_KEY.trim();
  if (env.AGGREGATOR_BASE_URL?.trim()) config.baseUrl = env.AGGREGATOR_BASE_URL.trim();
  return config;
}
