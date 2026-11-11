"use client";

import type { Provider, SocialAccount } from "@klipz/shared";
import { PROVIDERS } from "@klipz/shared";
import { AlertTriangle, FlaskConical, Plug, RefreshCw, Unplug } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/project/confirm-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Badge, Card } from "@/components/ui/primitives";
import { PROVIDER_META } from "@/lib/social-ui";
import type { AccountsResponse } from "@/lib/social-api";
import { api, cn } from "@/lib/utils";

const linkBtn =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold whitespace-nowrap transition-colors";

export function AccountsView() {
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SocialAccount | null>(null);
  const { toast, node } = useToast();
  const params = useSearchParams();
  const router = useRouter();
  const announced = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await api<AccountsResponse>("/api/accounts"));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load accounts");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ?connected=<provider>&n=<count> / ?error=<message> come from the OAuth callback.
  useEffect(() => {
    if (announced.current) return;
    const connected = params.get("connected");
    const error = params.get("error");
    if (!connected && !error && !params.get("connect")) return;
    announced.current = true;
    if (error) toast("error", `Connection failed: ${error}`);
    else if (params.get("connect")) toast("info", "Use the Connect button on this page to add that account.");
    else {
      const n = Number(params.get("n") ?? "1") || 1;
      toast("success", `${PROVIDER_META[connected as Provider]?.label ?? connected} connected (${n} account${n === 1 ? "" : "s"}).`);
    }
    router.replace("/accounts");
  }, [params, router, toast]);

  const addSandbox = async (provider: Provider) => {
    setBusy(`sandbox:${provider}`);
    try {
      await api("/api/accounts/sandbox", { method: "POST", json: { provider } });
      await load();
      toast("success", `Sandbox ${PROVIDER_META[provider].label} account added.`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Could not add sandbox account");
    } finally {
      setBusy(null);
    }
  };

  /** Sandbox / aggregator connects create the account server-side, so they are a same-origin POST, never a link. */
  const connectViaPost = async (provider: Provider) => {
    setBusy(`connect:${provider}`);
    try {
      await api(`/api/oauth/${provider}/start`, { method: "POST", json: {} });
      await load();
      toast("success", `${PROVIDER_META[provider].label} connected.`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Could not connect");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (a: SocialAccount) => {
    setBusy(`disc:${a.id}`);
    try {
      await api(`/api/accounts/${a.id}`, { method: "DELETE" });
      setConfirm(null);
      await load();
      toast("success", `${a.display_name} disconnected. Its stored tokens were deleted.`);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Could not disconnect");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-black tracking-tight">Accounts</h1>
        <p className="text-sm text-muted">Connect the platforms KLIPZ may post to. Tokens are encrypted on this PC and never shown.</p>
      </header>

      {data?.sandbox ? (
        <div role="note" data-testid="sandbox-banner" className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn/10 p-4">
          <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-warn" aria-hidden />
          <div>
            <p className="font-bold text-warn">Sandbox mode — nothing is posted to real platforms</p>
            <p className="text-sm text-muted">
              <code className="rounded bg-panel-2 px-1">KLIPZ_PUBLISH_MOCK=1</code> is set. Use &ldquo;Add sandbox account&rdquo; to try the whole flow with fake accounts; posts get made-up links and metrics.
            </p>
          </div>
        </div>
      ) : null}

      {data?.aggregator ? (
        <p className="text-sm text-muted">
          Aggregator <strong className="text-fg">{data.aggregator.kind}</strong> is configured for: {data.aggregator.providers.map((p) => PROVIDER_META[p].label).join(", ")}. Those platforms post through it.
        </p>
      ) : null}

      {loadError ? (
        <p role="alert" className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
          {loadError}
        </p>
      ) : null}

      {!data && !loadError ? <p className="text-sm text-muted">Loading…</p> : null}

      {data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p}
              provider={p}
              data={data}
              busy={busy}
              onSandbox={() => void addSandbox(p)}
              onConnectPost={() => void connectViaPost(p)}
              onDisconnect={(a) => setConfirm(a)}
            />
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        title={`Disconnect ${confirm?.display_name ?? ""}?`}
        confirmLabel="Disconnect"
        busy={confirm ? busy === `disc:${confirm.id}` : false}
        onConfirm={() => confirm && void disconnect(confirm)}
        onCancel={() => setConfirm(null)}
      >
        KLIPZ deletes the stored tokens for this account. Scheduled posts for it will fail until you connect it again. Posts already published stay on the platform, and you can also revoke access in the platform&apos;s own settings.
      </ConfirmDialog>
      {node}
    </div>
  );
}

function ProviderCard({
  provider,
  data,
  busy,
  onSandbox,
  onConnectPost,
  onDisconnect,
}: {
  provider: Provider;
  data: AccountsResponse;
  busy: string | null;
  onSandbox: () => void;
  onConnectPost: () => void;
  onDisconnect: (a: SocialAccount) => void;
}) {
  const meta = PROVIDER_META[provider];
  const status = data.providers[provider];
  const accounts = data.accounts.filter((a) => a.provider === provider);
  const startHref = `/api/oauth/${provider}/start`;
  return (
    <Card className="flex flex-col gap-3 p-4" data-provider={provider}>
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: meta.color }} aria-hidden />
        <h2 className="text-lg font-bold">{meta.label}</h2>
        {status.viaAggregator ? <Badge tone="accent">via aggregator</Badge> : null}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {data.sandbox ? (
            <Button size="sm" variant="secondary" onClick={onSandbox} disabled={busy === `sandbox:${provider}`} data-testid={`sandbox-${provider}`}>
              <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Add sandbox account
            </Button>
          ) : null}
          {status.configured && (data.sandbox || status.viaAggregator) ? (
            <Button size="sm" onClick={onConnectPost} disabled={busy === `connect:${provider}`} data-testid={`connect-${provider}`}>
              <Plug className="h-3.5 w-3.5" aria-hidden /> {accounts.length ? "Connect another" : "Connect"}
            </Button>
          ) : status.configured ? (
            <a href={startHref} className={cn(linkBtn, "bg-accent text-white hover:bg-accent-2")} data-testid={`connect-${provider}`}>
              <Plug className="h-3.5 w-3.5" aria-hidden /> {accounts.length ? "Connect another" : "Connect"}
            </a>
          ) : (
            <Button size="sm" disabled aria-describedby={`why-${provider}`} data-testid={`connect-${provider}`}>
              <Plug className="h-3.5 w-3.5" aria-hidden /> Connect
            </Button>
          )}
        </div>
      </div>

      {!status.configured ? (
        <p id={`why-${provider}`} className="rounded-lg border border-line bg-bg p-2.5 text-xs text-muted" data-testid={`unconfigured-${provider}`}>
          Not configured: set {status.missing.map((m, i) => (
            <span key={m}>
              {i > 0 ? " and " : ""}
              <code className="rounded bg-panel-2 px-1 text-fg">{m}</code>
            </span>
          ))}{" "}
          in <code className="rounded bg-panel-2 px-1">apps/web/.env.local</code>, restart KLIPZ, and add{" "}
          <code className="break-all rounded bg-panel-2 px-1 text-fg">{status.redirectUri}</code> as the redirect URI in the platform&apos;s developer console. See README → Platform setup.
        </p>
      ) : null}

      {accounts.length === 0 ? (
        <p className="text-sm text-muted">No {meta.label} account connected.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} reconnectHref={startHref} onReconnectPost={data.sandbox || status.viaAggregator ? onConnectPost : undefined} reconnectable={status.configured || data.sandbox} busy={busy === `disc:${a.id}`} onDisconnect={() => onDisconnect(a)} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function expiryText(a: SocialAccount): string {
  if (!a.token_expires_at) return "Token does not expire (or expiry unknown)";
  const t = Date.parse(a.token_expires_at);
  if (Number.isNaN(t)) return "Token expiry unknown";
  const when = new Date(t).toLocaleString();
  return t < Date.now() ? `Access token expired ${when} (refreshed automatically on next use)` : `Access token valid until ${when}`;
}

function AccountRow({
  account: a,
  reconnectHref,
  onReconnectPost,
  reconnectable,
  busy,
  onDisconnect,
}: {
  account: SocialAccount;
  reconnectHref: string;
  onReconnectPost?: (() => void) | undefined;
  reconnectable: boolean;
  busy: boolean;
  onDisconnect: () => void;
}) {
  const sandbox = Boolean((a.meta as { sandbox?: boolean }).sandbox);
  const bad = a.status !== "active";
  return (
    <li className={cn("rounded-lg border p-3", bad ? "border-warn/40 bg-warn/5" : "border-line bg-panel-2/40")} data-account-id={a.id} data-status={a.status}>
      <div className="flex items-center gap-3">
        {a.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={a.avatar_url} alt="" className="h-9 w-9 shrink-0 rounded-full bg-panel-2 object-cover" referrerPolicy="no-referrer" />
        ) : (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-panel-2 text-sm font-bold text-muted" aria-hidden>
            {a.display_name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">{a.display_name}</p>
          <p className="truncate text-xs text-muted">{a.username ? `@${a.username.replace(/^@/, "")}` : "no username"}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {sandbox ? <Badge tone="warn">sandbox</Badge> : null}
          {a.via_aggregator ? <Badge tone="accent">via aggregator</Badge> : null}
          <Badge tone={a.status === "active" ? "good" : a.status === "needs_reconnect" ? "warn" : "bad"}>{a.status === "needs_reconnect" ? "Needs reconnect" : a.status === "revoked" ? "Revoked" : "Connected"}</Badge>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">{expiryText(a)}</p>
      {bad ? (
        <div role="alert" className="mt-2 flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 p-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />
          <p className="min-w-0">
            <strong className="text-warn">Reconnect this account.</strong> {a.last_error ?? "The platform rejected the saved credentials."}
          </p>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {bad && reconnectable && onReconnectPost ? (
          <Button size="sm" variant="secondary" onClick={onReconnectPost} data-testid={`reconnect-${a.id}`}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reconnect
          </Button>
        ) : bad && reconnectable ? (
          <a href={reconnectHref} className={cn(linkBtn, "bg-warn/15 text-warn border border-warn/30 hover:bg-warn/25")} data-testid={`reconnect-${a.id}`}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reconnect
          </a>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onDisconnect} disabled={busy} aria-label={`Disconnect ${a.display_name}`}>
          <Unplug className="h-3.5 w-3.5" aria-hidden /> Disconnect
        </Button>
      </div>
    </li>
  );
}

