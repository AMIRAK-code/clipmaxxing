export * from './types';
export { PublishError, isPublishError, type PublishErrorInit } from './errors';
export { PLATFORM_LIMITS, INSTAGRAM_RECOMMENDED_MAX_SEC, X_LONG_VIDEO_MAX_SEC } from './limits';
export { composeCaption, composeCaptionUntruncated, composeTitle, captionLength, xWeightedLength, normalizeHashtag, truncateText } from './caption';
export { backoffDelayMs, type BackoffOptions } from './backoff';
export {
  encryptToken,
  decryptToken,
  generateEncryptionKey,
  createPkce,
  signState,
  verifyState,
  type OAuthStatePayload,
  type SignStateOptions,
} from './crypto';
export { ensureFreshTokens, startConnect } from './oauth';
export {
  httpRequest,
  parseRetryAfter,
  defaultHttpError,
  openAssetSource,
  withAssetSource,
  memoryAssetSource,
  fetchRange,
  planChunks,
  uploadInChunks,
  pollUntil,
  type AssetSource,
  type ByteRange,
  type UploadChunk,
  type HttpRequestOptions,
  type HttpResult,
  type HttpErrorInfo,
  type ErrorMapper,
  type PollOptions,
} from './http';
export { validateCommon, hasErrors } from './validate';
export { getPublisher, getNativePublisher, aggregatorConfigFromEnv } from './registry';
export { createAggregatorPublisher } from './aggregator';

export { youtubePublisher, youtubeOptionsSchema, YOUTUBE_SCOPES, secondsUntilPacificMidnight, type YouTubeOptions } from './providers/youtube';
export {
  tiktokPublisher,
  tiktokOptionsSchema,
  getTikTokCreatorInfo,
  getTikTokConsentText,
  getTikTokDisclosureLabel,
  planTikTokChunks,
  TIKTOK_SCOPES,
  TIKTOK_PRIVACY_LEVELS,
  TIKTOK_CONSENT_TEXT,
  TIKTOK_CONSENT_TEXT_BRANDED,
  TIKTOK_LABEL_PROMOTIONAL,
  TIKTOK_LABEL_PAID_PARTNERSHIP,
  TIKTOK_BRANDED_PRIVACY_NOTICE,
  TIKTOK_DISCLOSURE_PROMPT,
  TIKTOK_MUSIC_USAGE_URL,
  TIKTOK_BRANDED_CONTENT_POLICY_URL,
  type TikTokCreatorInfo,
  type TikTokOptions,
  type TikTokPrivacyLevel,
} from './providers/tiktok';
export { instagramPublisher, instagramOptionsSchema, INSTAGRAM_SCOPES, type InstagramOptions } from './providers/instagram';
export { facebookPublisher, facebookOptionsSchema, FACEBOOK_SCOPES, type FacebookOptions } from './providers/facebook';
export { xPublisher, xOptionsSchema, X_SCOPES, type XOptions } from './providers/x';
export {
  linkedinPublisher,
  linkedinOptionsSchema,
  escapeLinkedInText,
  LINKEDIN_SCOPES,
  LINKEDIN_ORG_SCOPES,
  DEFAULT_LINKEDIN_VERSION,
  type LinkedInOptions,
} from './providers/linkedin';
export { DEFAULT_GRAPH_VERSION } from './providers/meta';
