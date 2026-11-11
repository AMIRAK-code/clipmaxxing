"use client";

import { AlertTriangle } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge, Select, Switch } from "@/components/ui/primitives";
import {
  privacyAllowed,
  sanitizeTikTok,
  tiktokConsentSentence,
  tiktokDisclosureComplete,
  tiktokDisclosureLabel,
  type TikTokForm,
} from "@/lib/composer";
import { PRIVACY_LABEL, type TikTokInfoResponse } from "@/lib/social-api";
import { api, cn } from "@/lib/utils";

export interface TikTokInfoState {
  info: TikTokInfoResponse | null;
  error: string | null;
  loading: boolean;
}

/** Creator info for the first selected TikTok account (live API, or fixed data in sandbox mode). */
export function useTikTokInfo(accountId: string | null): TikTokInfoState {
  const [state, setState] = useState<TikTokInfoState>({ info: null, error: null, loading: false });
  useEffect(() => {
    if (!accountId) {
      setState({ info: null, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ info: null, error: null, loading: true });
    api<TikTokInfoResponse>(`/api/tiktok/creator-info?accountId=${encodeURIComponent(accountId)}`)
      .then((info) => !cancelled && setState({ info, error: null, loading: false }))
      .catch((e) => !cancelled && setState({ info: null, error: e instanceof Error ? e.message : "Could not load TikTok creator info", loading: false }));
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  return state;
}

function Row({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p id={id} className="text-sm font-semibold">
          {label}
        </p>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * TikTok Content Sharing Guidelines UX: creator nickname, privacy picker with no default,
 * interaction toggles, commercial-content disclosure and the explicit consent line.
 */
export function TikTokPanel({
  state,
  form,
  onChange,
  durationSec,
  accountCount,
}: {
  state: TikTokInfoState;
  form: TikTokForm;
  onChange: (f: TikTokForm) => void;
  durationSec: number;
  accountCount: number;
}) {
  const { info, error, loading } = state;
  if (loading) return <p className="text-sm text-muted">Loading your TikTok creator settings…</p>;
  if (error || !info) {
    return (
      <p role="alert" className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error ?? "TikTok creator info is unavailable."} TikTok requires this before posting, so TikTok cannot be posted right now.
      </p>
    );
  }
  const c = info.creatorInfo;
  const copy = info.consent;
  const update = (patch: Partial<TikTokForm>) => onChange(sanitizeTikTok({ ...form, ...patch }, c));
  const label = tiktokDisclosureLabel(form, copy);
  const tooLong = durationSec > c.maxVideoPostDurationSec;

  return (
    <div className="flex flex-col gap-4" data-testid="tiktok-panel">
      <div className="flex items-center gap-3 rounded-lg border border-line bg-bg p-3">
        {c.creatorAvatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.creatorAvatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="grid h-9 w-9 place-items-center rounded-full bg-panel-2 text-sm font-bold text-muted" aria-hidden>
            {(c.creatorNickname ?? "T").slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="text-xs text-muted">Posting to TikTok as</p>
          <p className="truncate text-sm font-bold" data-testid="tiktok-nickname">
            {c.creatorNickname ?? c.creatorUsername ?? "your account"}
          </p>
        </div>
        {accountCount > 1 ? <Badge tone="warn" className="ml-auto">{accountCount} accounts share these settings</Badge> : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="tt-privacy" className="text-xs font-semibold uppercase tracking-wide text-muted">
          Who can view this video <span className="text-bad">*</span>
        </label>
        <Select id="tt-privacy" value={form.privacy ?? ""} onChange={(e) => update({ privacy: e.target.value || null })} className="w-full" data-testid="tiktok-privacy" aria-label="Who can view this video" aria-required="true">
          <option value="">Select who can view this video…</option>
          {c.privacyLevelOptions.map((o) => {
            const ok = privacyAllowed(o, form);
            return (
              <option key={o} value={o} disabled={!ok}>
                {PRIVACY_LABEL[o] ?? o}
                {!ok ? " (not available for branded content)" : ""}
              </option>
            );
          })}
        </Select>
        {form.disclose && form.brandedContent ? <p className="text-xs text-warn">{copy.brandedPrivacyNotice}</p> : null}
      </div>

      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Allow users to</legend>
        {(
          [
            ["Comment", "allowComment", c.commentDisabled],
            ["Duet", "allowDuet", c.duetDisabled],
            ["Stitch", "allowStitch", c.stitchDisabled],
          ] as const
        ).map(([name, key, disabledByCreator]) => (
          <Row key={key} id={`tt-${key}`} label={name} {...(disabledByCreator ? { hint: `Turned off in your TikTok settings` } : {})}>
            <Switch checked={form[key] && !disabledByCreator} disabled={disabledByCreator} onChange={(v) => update({ [key]: v })} label={`Allow ${name.toLowerCase()}`} />
          </Row>
        ))}
      </fieldset>

      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Commercial content</legend>
        <Row id="tt-disclose" label="Disclose video content" hint="Turn on if this video promotes yourself, a third party, or both.">
          <Switch checked={form.disclose} onChange={(v) => update({ disclose: v })} label="Disclose video content" />
        </Row>
        {form.disclose ? (
          <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" checked={form.yourBrand} onChange={(e) => update({ yourBrand: e.target.checked })} className="mt-1" data-testid="tiktok-your-brand" />
              <span>
                <strong>Your brand</strong>
                <span className="block text-xs text-muted">You are promoting yourself or your own business.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" checked={form.brandedContent} onChange={(e) => update({ brandedContent: e.target.checked })} className="mt-1" data-testid="tiktok-branded" />
              <span>
                <strong>Branded content</strong>
                <span className="block text-xs text-muted">You are promoting another brand or a third party (paid partnership).</span>
              </span>
            </label>
            {!tiktokDisclosureComplete(form) ? (
              <p role="alert" className="text-xs text-bad">
                {copy.disclosurePrompt}
              </p>
            ) : null}
            {label ? (
              <p className="rounded-md bg-accent/10 px-2 py-1.5 text-xs text-accent-2" data-testid="tiktok-label">
                {label}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>

      {tooLong ? (
        <p role="alert" className="text-xs text-bad">
          This video is {Math.round(durationSec)} s long but your TikTok account allows at most {c.maxVideoPostDurationSec} s.
        </p>
      ) : (
        <p className="text-xs text-muted">Length OK: {Math.round(durationSec)} s (your limit: {c.maxVideoPostDurationSec} s).</p>
      )}

      <div className={cn("rounded-lg border p-3", form.consent ? "border-good/40" : "border-line")}>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" checked={form.consent} onChange={(e) => update({ consent: e.target.checked })} className="mt-1" data-testid="tiktok-consent" />
          <span data-testid="tiktok-consent-text">{tiktokConsentSentence(form, copy)}</span>
        </label>
        <p className="mt-1 pl-6 text-xs text-muted">
          Read the{" "}
          <a href={copy.musicUsageUrl} target="_blank" rel="noreferrer noopener" className="text-accent-2 underline">
            Music Usage Confirmation
          </a>
          {form.disclose && form.brandedContent ? (
            <>
              {" and the "}
              <a href={copy.brandedContentPolicyUrl} target="_blank" rel="noreferrer noopener" className="text-accent-2 underline">
                Branded Content Policy
              </a>
            </>
          ) : null}
          . Posting is blocked until you tick this box.
        </p>
      </div>
      <p className="text-xs text-muted">After you post, TikTok may take a few minutes to finish processing the video before it is visible.</p>
    </div>
  );
}
