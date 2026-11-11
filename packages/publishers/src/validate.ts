import { isAbsolute } from 'node:path';
import type { z } from 'zod';
import { captionLength, composeCaptionUntruncated, countHashtags } from './caption';
import { PLATFORM_LIMITS } from './limits';
import type { PostMeta, Provider, RenderAsset, ValidationIssue } from './types';

export function issue(field: string, code: string, message: string, severity: 'error' | 'warning' = 'error'): ValidationIssue {
  return { field, code, message, severity };
}

export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export type CodecFamily = 'h264' | 'hevc' | 'vp9' | 'av1' | 'aac' | 'other';

export function codecFamily(codec: string): CodecFamily {
  const c = (codec ?? '').toLowerCase();
  if (/h\.?264|avc/.test(c)) return 'h264';
  if (/hevc|h\.?265|hvc1|hev1/.test(c)) return 'hevc';
  if (/vp0?9/.test(c)) return 'vp9';
  if (/av0?1/.test(c)) return 'av1';
  if (/aac|mp4a/.test(c)) return 'aac';
  return 'other';
}

export interface CommonValidationOptions {
  /** Override the max duration (e.g. TikTok creator-specific cap). */
  maxDurationSec?: number;
  maxSizeBytes?: number;
  minSizeBytes?: number;
  /** Accepted video codec families. Default: h264 only. */
  videoCodecs?: CodecFamily[];
  /** Platform can only ingest a public URL (aggregators). */
  requireUrl?: boolean;
}

const fmtMb = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

/** Checks shared by every provider: source, container/codec, duration, size, aspect, fps, caption, title, hashtags. */
export function validateCommon(
  provider: Provider,
  render: RenderAsset,
  meta: PostMeta,
  opts: CommonValidationOptions = {},
): ValidationIssue[] {
  const limits = PLATFORM_LIMITS[provider];
  const issues: ValidationIssue[] = [];

  if (!render.filePath && !render.url) {
    issues.push(issue('render', 'asset_missing', 'Render needs a local filePath or a url.'));
  }
  if (render.filePath && !isAbsolute(render.filePath)) {
    issues.push(issue('render.filePath', 'file_path_not_absolute', 'Render filePath must be an absolute path.'));
  }
  if (render.url && !/^https:\/\//i.test(render.url)) {
    issues.push(issue('render.url', 'url_not_https', 'Render URL must be a public HTTPS URL.', render.filePath ? 'warning' : 'error'));
  }
  if (opts.requireUrl && !render.url) {
    issues.push(issue('render.url', 'asset_url_required', 'This route can only publish from a public HTTPS URL, not a local file.'));
  }
  if (render.mimeType !== 'video/mp4') {
    issues.push(issue('render.mimeType', 'unsupported_container', 'Video must be an MP4 file.'));
  }
  const videoCodecs = opts.videoCodecs ?? ['h264'];
  if (!videoCodecs.includes(codecFamily(render.videoCodec))) {
    issues.push(issue('render.videoCodec', 'unsupported_video_codec', `Video codec "${render.videoCodec}" is not accepted (expected ${videoCodecs.join('/')}).`));
  }
  if (codecFamily(render.audioCodec) !== 'aac') {
    issues.push(issue('render.audioCodec', 'unsupported_audio_codec', `Audio codec "${render.audioCodec}" is not accepted (expected AAC).`));
  }

  const maxDuration = opts.maxDurationSec ?? limits.maxDurationSec;
  if (!(render.durationSec > 0)) {
    issues.push(issue('render.durationSec', 'duration_invalid', 'Video duration is unknown.'));
  } else if (render.durationSec > maxDuration) {
    issues.push(issue('render.durationSec', 'duration_too_long', `Video is ${render.durationSec.toFixed(1)}s; the maximum is ${maxDuration}s.`));
  } else if (render.durationSec < limits.minDurationSec) {
    issues.push(issue('render.durationSec', 'duration_too_short', `Video is ${render.durationSec.toFixed(1)}s; the minimum is ${limits.minDurationSec}s.`));
  }

  const maxSize = opts.maxSizeBytes ?? limits.maxSizeBytes;
  if (!(render.sizeBytes > 0)) {
    issues.push(issue('render.sizeBytes', 'size_invalid', 'Video file size is unknown.'));
  } else if (render.sizeBytes > maxSize) {
    issues.push(issue('render.sizeBytes', 'file_too_large', `File is ${fmtMb(render.sizeBytes)}; the maximum is ${fmtMb(maxSize)}.`));
  } else if (opts.minSizeBytes !== undefined && render.sizeBytes < opts.minSizeBytes) {
    issues.push(issue('render.sizeBytes', 'file_too_small', `File is smaller than the ${opts.minSizeBytes} byte minimum.`));
  }

  if (!(render.width > 0) || !(render.height > 0)) {
    issues.push(issue('render.width', 'dimensions_invalid', 'Video dimensions are unknown.'));
  } else {
    const aspect = render.width / render.height;
    const tol = 0.01;
    if (aspect < limits.aspect.min - tol || aspect > limits.aspect.max + tol) {
      issues.push(
        issue(
          'render.width',
          'aspect_ratio_unsupported',
          `Aspect ratio ${render.width}x${render.height} (${aspect.toFixed(3)}) is outside ${limits.aspect.min.toFixed(3)}-${limits.aspect.max.toFixed(3)} (width/height).`,
        ),
      );
    } else if (aspect > 0.6 && provider !== 'x' && provider !== 'linkedin') {
      issues.push(issue('render.width', 'aspect_not_vertical', 'Video is not 9:16 vertical; it may be letterboxed or not treated as a short.', 'warning'));
    }
  }

  if (!(render.fps > 0)) {
    issues.push(issue('render.fps', 'fps_invalid', 'Frame rate is unknown.'));
  } else if (render.fps < limits.fps.min - 0.01 || render.fps > limits.fps.max + 0.01) {
    issues.push(issue('render.fps', 'fps_unsupported', `Frame rate ${render.fps} is outside ${limits.fps.min}-${limits.fps.max} fps.`));
  }

  const caption = composeCaptionUntruncated(provider, meta);
  const len = captionLength(provider, caption);
  if (len > limits.captionMax) {
    issues.push(issue('caption', 'caption_too_long', `Caption with hashtags is ${len} characters; the maximum is ${limits.captionMax}.`));
  }
  if (limits.titleMax !== undefined && meta.title !== undefined && meta.title.length > limits.titleMax) {
    issues.push(issue('title', 'title_too_long', `Title is ${meta.title.length} characters; the maximum is ${limits.titleMax}.`));
  }
  if (limits.hashtagMax !== undefined) {
    const count = countHashtags(provider, meta);
    if (count > limits.hashtagMax) {
      issues.push(issue('hashtags', 'too_many_hashtags', `${count} hashtags; the maximum is ${limits.hashtagMax}.`));
    }
  }
  return issues;
}

/** Parse provider options with zod; returns issues instead of throwing. */
export function parseOptions<S extends z.ZodTypeAny>(
  schema: S,
  options: unknown,
): { data?: z.infer<S>; issues: ValidationIssue[] } {
  const result = schema.safeParse(options ?? {});
  if (result.success) return { data: result.data as z.infer<S>, issues: [] };
  return {
    issues: result.error.issues.map((i) =>
      issue(`options.${i.path.join('.') || '_'}`, 'invalid_option', i.message),
    ),
  };
}
