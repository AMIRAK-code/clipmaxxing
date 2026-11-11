import { PLATFORM_LIMITS } from './limits';
import type { PostMeta, Provider } from './types';

const ELLIPSIS = '…';
const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu;
const URL_RE = /https?:\/\/[^\s]+/gi;

/** Strip `#`, whitespace and characters that would break a hashtag. Returns undefined when empty. */
export function normalizeHashtag(tag: string): string | undefined {
  const cleaned = tag.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * X weighted length (twitter-text v3 config): every http(s) URL counts 23; code points in
 * U+0000-10FF, U+2000-200D, U+2010-201F, U+2032-2037 weigh 1, everything else (CJK, emoji) 2.
 * https://docs.x.com/resources/fundamentals/counting-characters
 */
export function xWeightedLength(text: string): number {
  const normalized = text.normalize('NFC');
  let length = 0;
  let last = 0;
  const count = (segment: string): void => {
    for (const ch of segment) {
      const cp = ch.codePointAt(0) ?? 0;
      const light =
        cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
      length += light ? 1 : 2;
    }
  };
  for (const match of normalized.matchAll(URL_RE)) {
    const idx = match.index ?? 0;
    count(normalized.slice(last, idx));
    length += 23;
    last = idx + match[0].length;
  }
  count(normalized.slice(last));
  return length;
}

/** Length of `text` as the given platform counts it. */
export function captionLength(provider: Provider, text: string): number {
  return provider === 'x' ? xWeightedLength(text) : text.length;
}

/**
 * Truncate to `max` (as measured by `lengthOf`) on a word boundary, appending an ellipsis.
 * Never leaves half a word / hashtag / URL behind.
 */
export function truncateText(text: string, max: number, lengthOf: (s: string) => number = (s) => s.length): string {
  if (lengthOf(text) <= max) return text;
  if (max <= 0) return '';
  const cps = Array.from(text);
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lengthOf(cps.slice(0, mid).join('') + ELLIPSIS) <= max) lo = mid;
    else hi = mid - 1;
  }
  let prefix = cps.slice(0, lo).join('');
  const next = cps[lo];
  const cutMidWord = next !== undefined && !/\s/.test(next) && prefix.length > 0 && !/\s$/.test(prefix);
  if (cutMidWord) {
    const lastSpace = prefix.search(/\s\S*$/);
    if (lastSpace >= 0) prefix = prefix.slice(0, lastSpace);
    else if (/^(#|@|https?:)/i.test(prefix)) prefix = '';
  }
  prefix = prefix.replace(/[\s.,;:!?\-]+$/u, '');
  return prefix.length > 0 ? prefix + ELLIPSIS : '';
}

interface CaptionParts {
  caption: string;
  /** Optional hashtags, with '#', deduplicated, not already present in the caption. */
  tags: string[];
  /** Hashtags that must be present (YouTube: #Shorts). */
  required: string[];
  separator: string;
}

function captionParts(provider: Provider, meta: PostMeta): CaptionParts {
  const caption = (meta.caption ?? '').trim();
  const seen = new Set<string>();
  for (const m of caption.matchAll(HASHTAG_RE)) if (m[1]) seen.add(m[1].toLowerCase());
  const required: string[] = [];
  if (provider === 'youtube' && !seen.has('shorts')) {
    required.push('#Shorts');
    seen.add('shorts');
  }
  const tags: string[] = [];
  for (const raw of meta.hashtags ?? []) {
    const tag = typeof raw === 'string' ? normalizeHashtag(raw) : undefined;
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(`#${tag}`);
  }
  return { caption, tags, required, separator: provider === 'x' ? ' ' : '\n\n' };
}

function join(caption: string, tags: string[], separator: string): string {
  if (tags.length === 0) return caption;
  return caption ? `${caption}${separator}${tags.join(' ')}` : tags.join(' ');
}

/** Caption + all hashtags with no truncation (used by validate() to measure overflow). */
export function composeCaptionUntruncated(provider: Provider, meta: PostMeta): string {
  const p = captionParts(provider, meta);
  return join(p.caption, [...p.tags, ...p.required], p.separator);
}

/** Number of distinct hashtags the composed caption would carry (caption-inline + list + required). */
export function countHashtags(provider: Provider, meta: PostMeta): number {
  const text = composeCaptionUntruncated(provider, meta);
  return new Set(Array.from(text.matchAll(HASHTAG_RE), (m) => (m[1] ?? '').toLowerCase())).size;
}

/**
 * Caption + hashtags formatted for the platform and safely truncated to its limit:
 *  - the caption text is cut on a word boundary (with an ellipsis) if it alone is too long;
 *  - hashtags are appended whole while they fit (never cut in half), up to the platform hashtag cap;
 *  - YouTube always carries #Shorts.
 */
export function composeCaption(provider: Provider, meta: PostMeta): string {
  const limits = PLATFORM_LIMITS[provider];
  const lengthOf = (s: string): number => captionLength(provider, s);
  const p = captionParts(provider, meta);
  const requiredStr = p.required.join(' ');
  const reserve = requiredStr ? lengthOf(requiredStr) + lengthOf(p.separator) : 0;
  const caption = truncateText(p.caption, Math.max(0, limits.captionMax - reserve), lengthOf);

  const inline = new Set(Array.from(caption.matchAll(HASHTAG_RE), (m) => (m[1] ?? '').toLowerCase())).size;
  const maxTags = limits.hashtagMax !== undefined ? Math.max(0, limits.hashtagMax - inline - p.required.length) : Infinity;
  const chosen: string[] = [];
  for (const tag of p.tags) {
    if (chosen.length >= maxTags) break;
    const candidate = join(caption, [...chosen, tag, ...p.required], p.separator);
    if (lengthOf(candidate) > limits.captionMax) break;
    chosen.push(tag);
  }
  return join(caption, [...chosen, ...p.required], p.separator);
}

/** Title for platforms that have one (YouTube): explicit title or first caption line, truncated. */
export function composeTitle(provider: Provider, meta: PostMeta, opts: { appendShorts?: boolean } = {}): string {
  const max = PLATFORM_LIMITS[provider].titleMax ?? 100;
  const firstLine = (meta.caption ?? '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  // YouTube rejects '<' and '>' in titles.
  let title = ((meta.title ?? '').trim() || firstLine.trim() || 'Untitled').replace(/[<>]/g, '');
  const suffix = ' #Shorts';
  const wantsShorts = opts.appendShorts === true && !/#shorts\b/i.test(title);
  title = truncateText(title, wantsShorts ? max - suffix.length : max);
  if (!title) title = 'Untitled';
  return wantsShorts ? `${title}${suffix}` : title;
}
