import { describe, expect, it } from "vitest";
import {
  buildPostRequest,
  emptyTikTokForm,
  overrideHasText,
  privacyAllowed,
  sanitizeTikTok,
  tiktokConsentSentence,
  tiktokDisclosureComplete,
  tiktokDisclosureLabel,
  tiktokOptions,
  type ComposerState,
} from "./composer";

const copy = {
  text: "By posting, you agree to TikTok's Music Usage Confirmation",
  brandedText: "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation",
  labelPromotional: "Promotional content",
  labelPaidPartnership: "Paid partnership",
};
const creator = { privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], commentDisabled: false, duetDisabled: true, stitchDisabled: false };

describe("TikTok form rules", () => {
  it("starts with NO privacy selected and everything off", () => {
    const f = emptyTikTokForm();
    expect(f.privacy).toBeNull();
    expect(tiktokOptions(f, creator)).not.toHaveProperty("privacyLevel");
    expect(tiktokOptions(f, creator)).toMatchObject({ disableComment: true, disableDuet: true, disableStitch: true, consentAccepted: false, discloseCommercialContent: false });
  });

  it("maps allow-toggles to disable flags and forces creator-disabled interactions off", () => {
    const f = { ...emptyTikTokForm(), privacy: "PUBLIC_TO_EVERYONE", allowComment: true, allowDuet: true, allowStitch: true, consent: true };
    expect(tiktokOptions(f, creator)).toMatchObject({ privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: true, disableStitch: false, consentAccepted: true });
    expect(sanitizeTikTok(f, creator).allowDuet).toBe(false);
  });

  it("branded content cannot be private", () => {
    const f = { ...emptyTikTokForm(), privacy: "SELF_ONLY", disclose: true, brandedContent: true };
    expect(privacyAllowed("SELF_ONLY", f)).toBe(false);
    expect(privacyAllowed("PUBLIC_TO_EVERYONE", f)).toBe(true);
    expect(sanitizeTikTok(f, creator).privacy).toBeNull();
    // "Your brand" alone may be private
    expect(sanitizeTikTok({ ...f, brandedContent: false, yourBrand: true }, creator).privacy).toBe("SELF_ONLY");
  });

  it("drops a privacy option the creator does not offer", () => {
    expect(sanitizeTikTok({ ...emptyTikTokForm(), privacy: "FOLLOWER_OF_CREATOR" }, creator).privacy).toBeNull();
  });

  it("turning disclosure off clears the brand choices", () => {
    const f = sanitizeTikTok({ ...emptyTikTokForm(), disclose: false, yourBrand: true, brandedContent: true }, creator);
    expect(f.yourBrand).toBe(false);
    expect(f.brandedContent).toBe(false);
  });

  it("label and consent sentence variants", () => {
    const base = emptyTikTokForm();
    expect(tiktokDisclosureLabel(base, copy)).toBeUndefined();
    expect(tiktokDisclosureLabel({ ...base, disclose: true }, copy)).toBeUndefined();
    expect(tiktokDisclosureLabel({ ...base, disclose: true, yourBrand: true }, copy)).toBe("Promotional content");
    expect(tiktokDisclosureLabel({ ...base, disclose: true, yourBrand: true, brandedContent: true }, copy)).toBe("Paid partnership");
    expect(tiktokConsentSentence(base, copy)).toBe(copy.text);
    expect(tiktokConsentSentence({ ...base, disclose: true, brandedContent: true }, copy)).toBe(copy.brandedText);
    expect(tiktokConsentSentence({ ...base, disclose: true, yourBrand: true }, copy)).toBe(copy.text);
  });

  it("flags incomplete disclosure and only sends brand toggles when disclosure is on", () => {
    expect(tiktokDisclosureComplete({ ...emptyTikTokForm(), disclose: true })).toBe(false);
    expect(tiktokDisclosureComplete({ ...emptyTikTokForm(), disclose: true, yourBrand: true })).toBe(true);
    expect(tiktokOptions({ ...emptyTikTokForm(), disclose: false, yourBrand: true }, null)).toMatchObject({ brandOrganicToggle: false, brandContentToggle: false });
  });
});

const state = (over: Partial<ComposerState> = {}): ComposerState => ({
  clipId: "c1",
  renderId: "r1",
  accounts: [
    { id: "a-yt", provider: "youtube" },
    { id: "a-x", provider: "x" },
    { id: "a-x2", provider: "x" },
  ],
  shared: { caption: "Hello world", hashtagsText: "#a #b", title: "  My title " },
  overrides: {},
  options: {},
  coverTimestampMs: null,
  schedule: null,
  ...over,
});

describe("buildPostRequest", () => {
  it("builds the minimal request", () => {
    expect(buildPostRequest(state())).toEqual({
      clipId: "c1",
      renderId: "r1",
      accountIds: ["a-yt", "a-x", "a-x2"],
      caption: "Hello world",
      hashtags: ["a", "b"],
      title: "My title",
    });
  });

  it("applies a platform override to every account of that platform, keeping empty strings", () => {
    const r = buildPostRequest(state({ overrides: { x: { caption: "", hashtagsText: "#only" } } }));
    expect(r.overrides).toEqual({ "a-x": { caption: "", hashtags: ["only"] }, "a-x2": { caption: "", hashtags: ["only"] } });
  });

  it("includes cover, schedule and options only for selected providers", () => {
    const r = buildPostRequest(
      state({
        coverTimestampMs: 1234.7,
        schedule: { scheduledAt: "2026-12-01T10:00:00.000Z", timezone: "Europe/Berlin" },
        options: { youtube: { privacyStatus: "unlisted" }, tiktok: { privacyLevel: "SELF_ONLY" } },
      }),
    );
    expect(r.coverTimestampMs).toBe(1235);
    expect(r.scheduledAt).toBe("2026-12-01T10:00:00.000Z");
    expect(r.timezone).toBe("Europe/Berlin");
    expect(r.options).toEqual({ youtube: { privacyStatus: "unlisted" } });
  });

  it("sends the browser zone for post-now", () => {
    expect(buildPostRequest(state({ timezone: "Asia/Tokyo" })).timezone).toBe("Asia/Tokyo");
  });
});

describe("overrideHasText", () => {
  it("only counts non-blank text", () => {
    expect(overrideHasText(undefined)).toBe(false);
    expect(overrideHasText({ caption: "  " })).toBe(false);
    expect(overrideHasText({ hashtagsText: "#x" })).toBe(true);
  });
});
