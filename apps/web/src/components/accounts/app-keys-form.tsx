"use client";

import type { Provider } from "@klipz/shared";
import { Check, Copy, ExternalLink, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { api } from "@/lib/utils";

/** Where to create each platform's developer app, and what the console calls the two values. */
export const APP_KEY_INFO: Record<Provider, { console: string; idLabel: string; secretLabel: string; note?: string }> = {
  youtube: { console: "https://console.cloud.google.com/apis/credentials", idLabel: "Client ID", secretLabel: "Client secret" },
  tiktok: {
    console: "https://developers.tiktok.com/apps",
    idLabel: "Client key",
    secretLabel: "Client secret",
    note: "Choose the Desktop platform for your TikTok app (Login Kit + Content Posting API with Direct Post): desktop apps may use this http://localhost redirect. Add your own TikTok account as a target user in the sandbox. Until TikTok audits your app, posts are private (only you can see them).",
  },
  instagram: {
    console: "https://developers.facebook.com/apps",
    idLabel: "Meta App ID",
    secretLabel: "Meta App secret",
    note: "Instagram and Facebook share one Meta app (type Business, with Facebook Login for Business). Your Instagram account must be Business or Creator and linked to a Facebook Page. Keep the app in Development mode (localhost redirects only work there) and sign in with the Facebook account that is admin of the app.",
  },
  facebook: { console: "https://developers.facebook.com/apps", idLabel: "Meta App ID", secretLabel: "Meta App secret", note: "Instagram and Facebook share one Meta app." },
  x: {
    console: "https://developer.x.com/en/portal/dashboard",
    idLabel: "OAuth 2.0 Client ID",
    secretLabel: "OAuth 2.0 Client secret",
    note: "Enable OAuth 2.0 as a Web App (confidential client). Posting video needs a paid tier or pay-per-use credits.",
  },
  linkedin: { console: "https://www.linkedin.com/developers/apps", idLabel: "Client ID", secretLabel: "Client secret" },
};

export function AppKeysForm({
  provider,
  redirectUri,
  onSaved,
  onCancel,
}: {
  provider: Provider;
  redirectUri: string;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const info = APP_KEY_INFO[provider];
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api(`/api/platform-keys/${provider}`, { method: "PUT", json: { clientId, clientSecret } });
      setClientSecret("");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the keys");
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the URI is selectable anyway */
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2.5 rounded-lg border border-line bg-bg p-3" data-testid={`app-keys-${provider}`}>
      <p className="flex items-center gap-1.5 text-xs font-semibold">
        <KeyRound className="h-3.5 w-3.5 text-accent-2" aria-hidden /> Your developer app keys
      </p>
      <ol className="list-decimal space-y-1 pl-4 text-xs text-muted">
        <li>
          Create an app in the{" "}
          <a href={info.console} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent-2 underline">
            developer console <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          .
        </li>
        <li>
          Add this redirect URI exactly:
          <span className="mt-1 flex items-center gap-1.5">
            <code className="min-w-0 flex-1 break-all rounded bg-panel-2 px-1.5 py-0.5 text-fg">{redirectUri}</code>
            <button type="button" onClick={() => void copy()} className="shrink-0 rounded p-1 text-muted hover:bg-panel-2 hover:text-fg" aria-label="Copy redirect URI">
              {copied ? <Check className="h-3.5 w-3.5 text-good" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
            </button>
          </span>
        </li>
        <li>Paste the two values below, then press Connect to sign in.</li>
      </ol>
      {info.note ? <p className="text-xs text-warn">{info.note}</p> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`cid-${provider}`}>{info.idLabel}</Label>
          <Input id={`cid-${provider}`} value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" spellCheck={false} required />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`csec-${provider}`}>{info.secretLabel}</Label>
          <Input id={`csec-${provider}`} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" spellCheck={false} required />
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">The secret is encrypted on this PC and never shown again.</p>
        <div className="flex gap-2">
          {onCancel ? (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={saving || !clientId.trim() || !clientSecret.trim()}>
            {saving ? "Saving…" : "Save keys"}
          </Button>
        </div>
      </div>
    </form>
  );
}
