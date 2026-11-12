// Client-side shapes of the social API responses (see apps/web/src/server/social and app/api).
import type { Provider, SocialAccount } from "@klipz/shared";

export interface ProviderStatusDto {
  configured: boolean;
  missing: string[];
  viaAggregator: boolean;
  redirectUri: string;
  keySource: "env" | "app" | null;
}

export interface AccountsResponse {
  accounts: SocialAccount[];
  providers: Record<Provider, ProviderStatusDto>;
  sandbox: boolean;
  aggregator: { kind: string; providers: Provider[] } | null;
}

export interface IssueDto {
  field: string;
  code: string;
  message: string;
  severity: "error" | "warning";
}

export interface ComposedDto {
  caption: string;
  title?: string;
  length: number;
  limit: number;
}

export interface ValidateResponse {
  issues: Record<string, IssueDto[]>;
  composed: Record<string, ComposedDto>;
}

export interface CaptionSuggestionDto {
  caption: string;
  hashtags: string[];
  title?: string;
}

export interface AiCaptionsResponse {
  generator: "claude" | "heuristic";
  model?: string;
  note?: string;
  captions: Partial<Record<Provider, CaptionSuggestionDto>>;
}

export interface BestTimeSlot {
  at: string;
  local: string;
  weekday: string | number;
  hour: number;
  reason: string;
}

export interface BestTimesResponse {
  timezone: string;
  suggestions: Partial<Record<Provider, { basis: "history" | "default"; sampleSize: number; slots: BestTimeSlot[] }>>;
}

export interface TikTokCreatorInfoDto {
  creatorAvatarUrl?: string;
  creatorUsername?: string;
  creatorNickname?: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

export interface TikTokConsentDto {
  text: string;
  brandedText: string;
  labelPromotional: string;
  labelPaidPartnership: string;
  brandedPrivacyNotice: string;
  disclosurePrompt: string;
  musicUsageUrl: string;
  brandedContentPolicyUrl: string;
}

export interface TikTokInfoResponse {
  creatorInfo: TikTokCreatorInfoDto;
  consent: TikTokConsentDto;
  sandbox: boolean;
}

export interface AnalyticsTotals {
  posts: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  impressions: number;
}

export interface AnalyticsResponse {
  days: number;
  since: string;
  totals: AnalyticsTotals;
  byProvider: Partial<Record<Provider, AnalyticsTotals>>;
  clips: {
    clipId: string;
    title: string | null;
    totals: AnalyticsTotals;
    providers: Partial<Record<Provider, { posts: number; views: number; likes: number; comments: number; shares: number; url: string | null; postId: string }>>;
  }[];
  series: { date: string; views: number; likes: number; comments: number; shares: number; viewsDelta: number; byProvider: Partial<Record<Provider, { views: number; viewsDelta: number }>> }[];
  lastCapturedOn: string | null;
}

export interface TickResponse {
  now: string;
  tick: { promoted: number; processed: number; published: number; processing: number; retried: number; failed: number };
  metrics?: { captured?: number; skippedToday?: number } & Record<string, unknown>;
}

export const PRIVACY_LABEL: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends (mutual follows)",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};
