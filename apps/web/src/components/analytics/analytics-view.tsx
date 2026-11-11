"use client";

import { PROVIDERS, type Provider } from "@klipz/shared";
import { BarChart3, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Card, EmptyState } from "@/components/ui/primitives";
import { share } from "@/lib/chart";
import { PROVIDER_META } from "@/lib/social-ui";
import type { AnalyticsResponse, TickResponse } from "@/lib/social-api";
import { api, cn, formatCount } from "@/lib/utils";
import { ViewsChart } from "./views-chart";

const RANGES = [7, 30, 90] as const;

export function AnalyticsView() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<"gained" | "total">("gained");
  const { toast, node } = useToast();

  const load = useCallback(async (d: number) => {
    try {
      setData(await api<AnalyticsResponse>(`/api/analytics?days=${d}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load analytics");
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api<TickResponse>("/api/cron/tick", { method: "POST", json: { metrics: true, force: true } });
      const m = r.metrics as { considered?: number; captured?: number; failed?: unknown[] } | undefined;
      const failed = m?.failed?.length ?? 0;
      toast(failed ? "error" : "success", `Metrics refreshed: ${m?.captured ?? 0} of ${m?.considered ?? 0} posts updated${failed ? `, ${failed} failed (account needs reconnecting?)` : ""}.`);
      await load(days);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const t = data?.totals;
  const providers = PROVIDERS.filter((p) => data?.byProvider[p]);
  const clipProviders = PROVIDERS.filter((p) => data?.clips.some((c) => c.providers[p]));
  const maxProviderViews = Math.max(1, ...providers.map((p) => data?.byProvider[p]?.views ?? 0));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Analytics</h1>
          <p className="text-sm text-muted" data-testid="last-updated">
            {data?.lastCapturedOn ? `Last updated ${data.lastCapturedOn} (UTC). Metrics are pulled hourly while KLIPZ runs.` : "No metrics captured yet."}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Date range" className="flex overflow-hidden rounded-lg border border-line">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={days === r}
                onClick={() => setDays(r)}
                className={cn("h-9 cursor-pointer px-3 text-sm font-semibold", days === r ? "bg-accent/20 text-accent-2" : "text-muted hover:bg-panel-2 hover:text-fg")}
              >
                {r} days
              </button>
            ))}
          </div>
          <Button variant="secondary" onClick={() => void refresh()} disabled={refreshing} data-testid="refresh-metrics">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />} Refresh metrics now
          </Button>
        </div>
      </header>

      {error ? (
        <p role="alert" className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className="text-sm text-muted">Loading…</p> : null}

      {data && t && t.posts === 0 ? (
        <EmptyState title={`No published posts in the last ${days} days`} icon={<BarChart3 className="h-8 w-8" />}>
          Post a clip from a project, then come back. Numbers appear after the first metrics pull.{" "}
          <Link href="/" className="text-accent-2 underline">
            Go to projects
          </Link>
        </EmptyState>
      ) : null}

      {data && t && t.posts > 0 ? (
        <>
          <section aria-label="Totals" className="grid grid-cols-2 gap-3 md:grid-cols-5">
            {(
              [
                ["Views", t.views],
                ["Likes", t.likes],
                ["Comments", t.comments],
                ["Shares", t.shares],
                ["Posts", t.posts],
              ] as const
            ).map(([label, v]) => (
              <Card key={label} className="p-4" data-testid={`kpi-${label.toLowerCase()}`}>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
                <p className="mt-1 text-3xl font-black tabular-nums" title={v.toLocaleString()}>
                  {formatCount(v)}
                </p>
              </Card>
            ))}
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Card className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="font-bold">Views over time</h2>
                <div role="group" aria-label="Chart type" className="ml-auto flex overflow-hidden rounded-lg border border-line text-xs">
                  {(["gained", "total"] as const).map((m) => (
                    <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cn("h-7 cursor-pointer px-2.5 font-semibold", mode === m ? "bg-accent/20 text-accent-2" : "text-muted hover:bg-panel-2")}>
                      {m === "gained" ? "Per day" : "Total"}
                    </button>
                  ))}
                </div>
              </div>
              {data.series.length > 0 ? (
                <ViewsChart series={data.series} mode={mode} />
              ) : (
                <p className="py-10 text-center text-sm text-muted" data-testid="chart-empty">
                  No daily data yet. Press &ldquo;Refresh metrics now&rdquo; to capture the first snapshot.
                </p>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="mb-3 font-bold">By platform</h2>
              <ul className="flex flex-col gap-3" data-testid="by-platform">
                {providers.map((p) => {
                  const b = data.byProvider[p]!;
                  return (
                    <li key={p}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="inline-flex items-center gap-2 font-semibold">
                          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PROVIDER_META[p].color }} aria-hidden />
                          {PROVIDER_META[p].label}
                        </span>
                        <span className="tabular-nums">{b.views.toLocaleString()} views</span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden rounded-full bg-panel-2" role="img" aria-label={`${PROVIDER_META[p].label}: ${Math.round(share(b.views, maxProviderViews) * 100)}% of the top platform`}>
                        <div className="h-full rounded-full" style={{ width: `${share(b.views, maxProviderViews) * 100}%`, background: PROVIDER_META[p].color }} />
                      </div>
                      <p className="mt-1 text-xs tabular-nums text-muted">
                        {b.posts} post{b.posts === 1 ? "" : "s"} · {b.likes.toLocaleString()} likes · {b.comments.toLocaleString()} comments · {b.shares.toLocaleString()} shares
                      </p>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </section>

          <Card className="overflow-hidden">
            <h2 className="p-4 pb-2 font-bold">Per clip</h2>
            <div className="overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-sm" data-testid="clip-table">
                <thead>
                  <tr className="border-b border-line text-xs text-muted">
                    <th scope="col" rowSpan={2} className="sticky left-0 z-10 bg-panel px-4 py-2 text-left font-semibold">
                      Clip
                    </th>
                    <th scope="col" rowSpan={2} className="px-3 py-2 text-right font-semibold">
                      Total views
                    </th>
                    {clipProviders.map((p) => (
                      <th key={p} scope="colgroup" colSpan={5} className="border-l border-line px-3 py-2 text-left font-semibold">
                        <span className="inline-flex items-center gap-2 text-fg">
                          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: PROVIDER_META[p].color }} aria-hidden />
                          {PROVIDER_META[p].label}
                        </span>
                      </th>
                    ))}
                  </tr>
                  <tr className="border-b border-line text-xs text-muted">
                    {clipProviders.map((p) =>
                      ["Views", "Likes", "Comm.", "Shares", "Link"].map((h, i) => (
                        <th key={`${p}-${h}`} scope="col" className={cn("px-3 py-1.5 text-right font-semibold", i === 0 && "border-l border-line", h === "Link" && "text-center")}>
                          {h}
                        </th>
                      )),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.clips.map((c) => (
                    <tr key={c.clipId} className="border-b border-line last:border-b-0">
                      <th scope="row" className="sticky left-0 z-10 max-w-[16rem] truncate bg-panel px-4 py-2 text-left font-semibold">
                        <Link href={`/clips/${c.clipId}`} className="hover:underline">
                          {c.title || "Untitled clip"}
                        </Link>
                      </th>
                      <td className="px-3 py-2 text-right font-bold tabular-nums">{c.totals.views.toLocaleString()}</td>
                      {clipProviders.map((p) => (
                        <ProviderCells key={p} provider={p} cell={c.providers[p]} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
      {node}
    </div>
  );
}

function ProviderCells({ provider, cell }: { provider: Provider; cell: AnalyticsResponse["clips"][number]["providers"][Provider] }) {
  const dash = <span className="text-muted">–</span>;
  return (
    <>
      <td className="border-l border-line px-3 py-2 text-right tabular-nums">{cell ? cell.views.toLocaleString() : dash}</td>
      <td className="px-3 py-2 text-right tabular-nums">{cell ? cell.likes.toLocaleString() : dash}</td>
      <td className="px-3 py-2 text-right tabular-nums">{cell ? cell.comments.toLocaleString() : dash}</td>
      <td className="px-3 py-2 text-right tabular-nums">{cell ? cell.shares.toLocaleString() : dash}</td>
      <td className="px-3 py-2 text-center">
        {cell?.url ? (
          <a href={cell.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${PROVIDER_META[provider].label} post`} className="inline-flex text-accent-2 hover:text-fg">
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        ) : (
          dash
        )}
      </td>
    </>
  );
}
