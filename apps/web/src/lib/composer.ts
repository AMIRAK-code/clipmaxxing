// Pure helpers behind the composer: request building and the TikTok audit-required option rules.
import type { Provider } from "@klipz/shared";
import { parseHashtags, type TextOverride } from "./social-ui";

// ── TikTok ──────────────────────────────────────────────────────────────

export interface TikTokForm {
  /** null = nothing chosen yet. TikTok forbids a default privacy level. */
  privacy: string | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** "Disclose video content" master switch */
  disclose: boolean;
  /** "Your brand" -> brandOrganicToggle */
  yourBrand: boolean;
  /** "Branded content" -> brandContentToggle */
  brandedContent: boolean;
  /** explicit confirmation of the consent sentence */
  consent: boolean;
}

export const emptyTikTokForm = (): TikTokForm => ({
  privacy: null,
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  disclose: false,
  yourBrand: false,
  brandedContent: false,
  consent: false,
});

export interface CreatorLimits {
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
}

/** Branded content may not be private. */
export const privacyAllowed = (level: string, f: Pick<TikTokForm, "disclose" | "brandedContent">): boolean => !(f.disclose && f.brandedContent && level === "SELF_ONLY");

/** Bring a form back into a state TikTok accepts after any change (never invents a privacy default). */
export function sanitizeTikTok(f: TikTokForm, creator: CreatorLimits | null): TikTokForm {
  const out = { ...f };
  if (!out.disclose) {
    out.yourBrand = false;
    out.brandedContent = false;
  }
  if (out.privacy && (!privacyAllowed(out.privacy, out) || (creator && !creator.privacyLevelOptions.includes(out.privacy)))) out.privacy = null;
  if (creator?.commentDisabled) out.allowComment = false;
  if (creator?.duetDisabled) out.allowDuet = false;
  if (creator?.stitchDisabled) out.allowStitch = false;
  return out;
}

/** The label TikTok will show, or undefined when nothing is disclosed. Matches getTikTokDisclosureLabel in @klipz/publishers. */
export function tiktokDisclosureLabel(f: TikTokForm, copy: { labelPromotional: string; labelPaidPartnership: string }): string | undefined {
  if (!f.disclose) return undefined;
  if (f.brandedContent) return copy.labelPaidPartnership;
  if (f.yourBrand) return copy.labelPromotional;
  return undefined;
}

export function tiktokConsentSentence(f: TikTokForm, copy: { text: string; brandedText: string }): string {
  return f.disclose && f.brandedContent ? copy.brandedText : copy.text;
}

/** Disclosure is complete: when the switch is on, at least one of the two choices must be picked. */
export const tiktokDisclosureComplete = (f: TikTokForm): boolean => !f.disclose || f.yourBrand || f.brandedContent;

export function tiktokOptions(f: TikTokForm, creator: CreatorLimits | null): Record<string, unknown> {
  const o: Record<string, unknown> = {
    disableComment: !f.allowComment || Boolean(creator?.commentDisabled),
    disableDuet: !f.allowDuet || Boolean(creator?.duetDisabled),
    disableStitch: !f.allowStitch || Boolean(creator?.stitchDisabled),
    discloseCommercialContent: f.disclose,
    brandOrganicToggle: f.disclose && f.yourBrand,
    brandContentToggle: f.disclose && f.brandedContent,
    consentAccepted: f.consent,
  };
  if (f.privacy) o.privacyLevel = f.privacy;
  return o;
}

// ── other platforms' options ────────────────────────────────────────────

export interface YouTubeForm {
  privacyStatus: "public" | "unlisted" | "private";
  madeForKids: boolean;
}
export const defaultYouTube = (): YouTubeForm => ({ privacyStatus: "public", madeForKids: false });

export interface InstagramForm {
  shareToFeed: boolean;
}
export const defaultInstagram = (): InstagramForm => ({ shareToFeed: true });

export interface LinkedInForm {
  visibility: "PUBLIC" | "CONNECTIONS";
}

export interface XForm {
  longVideo: boolean;
}

// ── request ─────────────────────────────────────────────────────────────

export interface ComposerSelection {
  id: string;
  provider: Provider;
}

export interface ComposerState {
  clipId: string;
  renderId: string;
  accounts: ComposerSelection[];
  shared: { caption: string; hashtagsText: string; title: string };
  overrides: Partial<Record<Provider, { caption?: string; hashtagsText?: string; title?: string }>>;
  options: Partial<Record<Provider, Record<string, unknown>>>;
  coverTimestampMs: number | null;
  schedule: { scheduledAt: string; timezone: string } | null;
  /** Browser zone, sent even for "post now" so the post row remembers it. */
  timezone?: string;
}

export interface PostRequest {
  clipId: string;
  renderId: string;
  accountIds: string[];
  caption: string;
  hashtags: string[];
  title?: string;
  coverTimestampMs?: number;
  scheduledAt?: string;
  timezone?: string;
  overrides?: Record<string, { caption?: string; hashtags?: string[]; title?: string }>;
  options?: Partial<Record<Provider, Record<string, unknown>>>;
}

export function buildPostRequest(s: ComposerState): PostRequest {
  const req: PostRequest = {
    clipId: s.clipId,
    renderId: s.renderId,
    accountIds: s.accounts.map((a) => a.id),
    caption: s.shared.caption,
    hashtags: parseHashtags(s.shared.hashtagsText),
  };
  if (s.shared.title.trim()) req.title = s.shared.title.trim();
  if (s.coverTimestampMs !== null) req.coverTimestampMs = Math.max(0, Math.round(s.coverTimestampMs));
  if (s.schedule) {
    req.scheduledAt = s.schedule.scheduledAt;
    req.timezone = s.schedule.timezone;
  } else if (s.timezone) req.timezone = s.timezone;

  const overrides: NonNullable<PostRequest["overrides"]> = {};
  for (const a of s.accounts) {
    const ov = s.overrides[a.provider];
    if (!ov) continue;
    const o: { caption?: string; hashtags?: string[]; title?: string } = {};
    if (ov.caption !== undefined) o.caption = ov.caption;
    if (ov.hashtagsText !== undefined) o.hashtags = parseHashtags(ov.hashtagsText);
    if (ov.title !== undefined) o.title = ov.title;
    if (Object.keys(o).length) overrides[a.id] = o;
  }
  if (Object.keys(overrides).length) req.overrides = overrides;

  const providers = new Set(s.accounts.map((a) => a.provider));
  const options: NonNullable<PostRequest["options"]> = {};
  for (const p of providers) {
    const o = s.options[p];
    if (o && Object.keys(o).length) options[p] = o;
  }
  if (Object.keys(options).length) req.options = options;
  return req;
}

/** Fields of an override with empty values dropped, so "" typed then cleared does not count as an override. */
export function overrideIsSet(ov: TextOverride | { caption?: string; hashtagsText?: string; title?: string } | undefined): boolean {
  if (!ov) return false;
  return Object.values(ov).some((v) => v !== undefined);
}

/** True if the platform override already holds text the user could have typed (so AI must ask before replacing it). */
export function overrideHasText(ov: { caption?: string; hashtagsText?: string; title?: string } | undefined): boolean {
  return Boolean(ov && ((ov.caption ?? "").trim() || (ov.hashtagsText ?? "").trim() || (ov.title ?? "").trim()));
}
