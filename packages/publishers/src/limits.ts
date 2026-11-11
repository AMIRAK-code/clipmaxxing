import type { PlatformLimits, Provider } from './types';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Platform limits used by validate(). Aspect is width / height (9:16 = 0.5625).
 *
 * Sources (checked 2026-11):
 *  - YouTube Shorts: <= 3 min, square or vertical. https://support.google.com/youtube/answer/15424877
 *    title 100 / description 5000: https://developers.google.com/youtube/v3/docs/videos#resource
 *  - TikTok: 2200 UTF-16 caption, 23-60 fps, <= 4 GB, <= 10 min via API (per-creator cap from creator_info).
 *    https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *  - Instagram Reels via API: 3 s - 15 min, 300 MB, 23-60 fps, caption 2200, 30 hashtags.
 *    https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 *  - Facebook Reels: 3-90 s, 9:16, 24-60 fps. https://developers.facebook.com/docs/video-api/guides/reels-publishing
 *    (no documented caption / size cap for reels: values below are conservative, not official)
 *  - X: 280 weighted chars; 140 s / 512 MB is the long-standing standard-account video limit
 *    (longer needs Premium, see X options.longVideo). https://docs.x.com/x-api/media/quickstart/media-upload-chunked
 *  - LinkedIn: 3 s - 30 min, 75 KB - 500 MB, commentary 3000.
 *    https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 */
export const PLATFORM_LIMITS: Record<Provider, PlatformLimits> = {
  youtube: {
    captionMax: 5000,
    titleMax: 100,
    hashtagMax: 60,
    maxDurationSec: 180,
    minDurationSec: 1,
    maxSizeBytes: 256 * GB,
    aspect: { min: 0.4, max: 1 },
    fps: { min: 1, max: 60 },
  },
  tiktok: {
    captionMax: 2200,
    maxDurationSec: 600,
    minDurationSec: 3,
    maxSizeBytes: 4 * GB,
    aspect: { min: 0.3, max: 3.4 },
    fps: { min: 23, max: 60 },
  },
  instagram: {
    captionMax: 2200,
    hashtagMax: 30,
    maxDurationSec: 900,
    minDurationSec: 3,
    maxSizeBytes: 300 * MB,
    aspect: { min: 0.01, max: 10 },
    fps: { min: 23, max: 60 },
  },
  facebook: {
    captionMax: 5000,
    titleMax: 255,
    maxDurationSec: 90,
    minDurationSec: 3,
    maxSizeBytes: 1 * GB,
    aspect: { min: 0.5, max: 0.6 },
    fps: { min: 24, max: 60 },
  },
  x: {
    captionMax: 280,
    maxDurationSec: 140,
    minDurationSec: 0.5,
    maxSizeBytes: 512 * MB,
    aspect: { min: 1 / 3, max: 3 },
    fps: { min: 1, max: 60 },
  },
  linkedin: {
    captionMax: 3000,
    titleMax: 200,
    maxDurationSec: 1800,
    minDurationSec: 3,
    maxSizeBytes: 500 * MB,
    aspect: { min: 1 / 2.4, max: 2.4 },
    fps: { min: 10, max: 60 },
  },
};

/** Instagram recommends Reels <= 90 s for full Reels-tab distribution (warning only). */
export const INSTAGRAM_RECOMMENDED_MAX_SEC = 90;
/** X: duration cap when the posting account has Premium (options.longVideo). */
export const X_LONG_VIDEO_MAX_SEC = 7500;
export const X_LONG_VIDEO_MAX_BYTES = 16 * GB;
/** LinkedIn minimum file size. */
export const LINKEDIN_MIN_SIZE_BYTES = 75 * 1024;
