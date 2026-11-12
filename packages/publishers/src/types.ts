/** Shared public types for @klipz/publishers. */

export type Provider = 'youtube' | 'tiktok' | 'instagram' | 'facebook' | 'x' | 'linkedin';

export const PROVIDERS: Provider[] = ['youtube', 'tiktok', 'instagram', 'facebook', 'x', 'linkedin'];

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** ISO-8601 timestamp. Absent = token does not expire (or expiry unknown). */
  expiresAt?: string;
  scopes: string[];
}

export interface AccountInfo {
  externalAccountId: string;
  displayName: string;
  username?: string;
  avatarUrl?: string;
  /** Non-secret provider data (ig user id, fb page id, linkedin author urn ...). Never tokens. */
  meta: Record<string, unknown>;
}

export interface RenderAsset {
  /** Absolute path of the rendered mp4 on the local disk (default source for KLIPZ). */
  filePath?: string;
  /** Publicly fetchable HTTPS URL of the mp4 (optional). At least one of filePath / url must be set. */
  url?: string;
  sizeBytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string;
  mimeType: 'video/mp4';
  coverUrl?: string;
}

export interface PostMeta {
  caption: string;
  hashtags: string[];
  title?: string;
  coverTimestampMs?: number;
  /** Provider-specific options, validated with zod per provider. */
  options: Record<string, unknown>;
}

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface PublishResult {
  externalId: string;
  status: 'published' | 'processing';
  url?: string;
}

export interface PostStatus {
  status: 'processing' | 'published' | 'failed';
  url?: string;
  error?: string;
  /**
   * Set when the provider-side id changed while resolving status (e.g. an Instagram
   * container id became a media id). Callers should persist it and use it from now on.
   */
  externalId?: string;
}

export interface PostMetrics {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  watchTimeSec?: number;
  impressions?: number;
  raw: unknown;
}

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  extra?: Record<string, string>;
}

export interface PublisherContext {
  config: ProviderConfig;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

export interface ConnectStart {
  authUrl: string;
  state: string;
  codeVerifier?: string;
}

export interface ConnectResult {
  tokens: TokenSet;
  accounts: AccountInfo[];
  /** Per-account tokens keyed by externalAccountId (e.g. Facebook page tokens). */
  accountTokens?: Record<string, TokenSet>;
}

export interface PlatformLimits {
  captionMax: number;
  titleMax?: number;
  hashtagMax?: number;
  maxDurationSec: number;
  minDurationSec: number;
  maxSizeBytes: number;
  /** width / height */
  aspect: { min: number; max: number };
  fps: { min: number; max: number };
}

export interface PublishArgs {
  tokens: TokenSet;
  account: AccountInfo;
  render: RenderAsset;
  meta: PostMeta;
}

export interface PostRefArgs {
  tokens: TokenSet;
  account: AccountInfo;
  externalId: string;
}

export interface Publisher {
  provider: Provider;
  limits: PlatformLimits;
  /** Connect step 1: build the provider authorization URL. */
  getAuthUrl(ctx: PublisherContext, args: { state: string; codeChallenge?: string }): string;
  /** How this provider expects the S256 code_challenge encoded (default RFC 7636 base64url; TikTok desktop: hex). */
  pkceEncoding?: 'base64url' | 'hex';
  /** Connect step 2: exchange the code and discover publishable accounts. */
  connect(ctx: PublisherContext, args: { code: string; codeVerifier?: string }): Promise<ConnectResult>;
  refresh(ctx: PublisherContext, tokens: TokenSet): Promise<TokenSet>;
  /** Pure + synchronous. Never throws. */
  validate(render: RenderAsset, meta: PostMeta, account?: AccountInfo): ValidationIssue[];
  publish(ctx: PublisherContext, args: PublishArgs): Promise<PublishResult>;
  getStatus(ctx: PublisherContext, args: PostRefArgs): Promise<PostStatus>;
  fetchMetrics(ctx: PublisherContext, args: PostRefArgs): Promise<PostMetrics>;
}

export interface AggregatorConfig {
  kind: 'upload-post' | 'ayrshare';
  apiKey: string;
  baseUrl?: string;
  /** Which providers are routed through the aggregator. */
  providers: Provider[];
  /** Upload-Post: profile ("user") name. Ayrshare: Profile-Key of the user profile. */
  profileKey?: string;
}
