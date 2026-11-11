"use client";

import { PROVIDERS, type PostStatus, type Provider } from "@klipz/shared";
import { Clock, ExternalLink, Loader2, Play, RotateCcw, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Badge, Card, EmptyState, Input, Select, Textarea } from "@/components/ui/primitives";
import { browserTimeZone, checkSchedule, formatCountdown, formatInZone, formatLocalValue, partsInZone } from "@/lib/schedule";
import { PROVIDER_META, STATUS_LABEL, groupBatches, isTerminalPost, summarizeBatch } from "@/lib/social-ui";
import type { TickResponse } from "@/lib/social-api";
import { api, cn, fileUrl } from "@/lib/utils";
import type { PostView } from "@/server/social/posts";

const POLL_MS = 3000;

type StatusFilter = "all" | "scheduled" | "active" | "published" | "failed" | "cancelled";
const FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "scheduled", label: "Scheduled" },
  { id: "active", label: "In progress" },
  { id: "published", label: "Published" },
  { id: "failed", label: "Failed" },
  { id: "cancelled", label: "Cancelled" },
];

const matchesStatus = (s: PostStatus, f: StatusFilter): boolean =>
  f === "all" ? true : f === "active" ? ["draft", "queued", "publishing", "processing"].includes(s) : s === f;

const TONE: Record<PostStatus, "default" | "good" | "warn" | "bad" | "accent"> = {
  draft: "default",
  scheduled: "accent",
  queued: "default",
  publishing: "warn",
  processing: "warn",
  published: "good",
  failed: "bad",
  cancelled: "default",
};

export function PostsView() {
  const params = useSearchParams();
  const batchParam = params.get("batch");
  const [posts, setPosts] = useState<PostView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [now, setNow] = useState(() => Date.now());
  const [running, setRunning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { toast, node } = useToast();

  const load = useCallback(async () => {
    try {
      const d = await api<{ posts: PostView[] }>("/api/posts");
      setPosts(d.posts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load posts");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const anyLive = !posts || posts.some((p) => !isTerminalPost(p.status));
  const anyScheduled = posts?.some((p) => p.status === "scheduled") ?? false;

  // Poll every 3 s while anything is not finished.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!anyLive) return;
    const id = setInterval(() => void loadRef.current(), POLL_MS);
    return () => clearInterval(id);
  }, [anyLive]);
  useEffect(() => {
    if (!anyScheduled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyScheduled]);

  const visible = useMemo(() => {
    let list = posts ?? [];
    if (batchParam) list = list.filter((p) => p.batch_id === batchParam);
    return list;
  }, [posts, batchParam]);
  const filtered = useMemo(() => visible.filter((p) => matchesStatus(p.status, status) && (provider === "all" || p.provider === provider)), [visible, status, provider]);
  const batches = useMemo(() => groupBatches(filtered), [filtered]);
  const totalsByBatch = useMemo(() => {
    const m = new Map<string, PostView[]>();
    for (const p of visible) (m.get(p.batch_id) ?? m.set(p.batch_id, []).get(p.batch_id)!).push(p);
    return m;
  }, [visible]);

  const act = async (post: PostView, action: "retry" | "cancel" | "reschedule" | "delete", extra?: { scheduledAt?: string; caption?: string }) => {
    setBusyId(post.id);
    try {
      if (action === "delete") await api(`/api/posts/${post.id}`, { method: "DELETE" });
      else await api(`/api/posts/${post.id}`, { method: "POST", json: action === "reschedule" ? { action, scheduledAt: extra?.scheduledAt } : action === "retry" && extra?.caption !== undefined ? { action, caption: extra.caption } : { action } });
      await load();
      toast("success", action === "retry" ? `${PROVIDER_META[post.provider].label}: queued again.` : action === "cancel" ? `${PROVIDER_META[post.provider].label}: cancelled.` : action === "delete" ? "Entry removed." : `${PROVIDER_META[post.provider].label}: rescheduled.`);
      return true;
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Action failed");
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api<TickResponse>("/api/cron/tick", { method: "POST", json: {} });
      const t = r.tick;
      const nothing = t.promoted + t.processed + t.published + t.processing + t.retried + t.failed === 0;
      toast("success", nothing ? "Scheduler ran: nothing was due." : `Scheduler ran: ${t.promoted} came due, ${t.published} published, ${t.processing} still processing, ${t.retried} to retry, ${t.failed} failed.`);
      await load();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Scheduler failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-start gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Posts</h1>
          <p className="text-sm text-muted">One row per platform. Status updates live.</p>
        </div>
        <Button variant="secondary" className="ml-auto" onClick={() => void runNow()} disabled={running} data-testid="run-scheduler">
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Run scheduler now
        </Button>
      </header>

      <p className="rounded-lg border border-line bg-panel px-3 py-2 text-xs text-muted" data-testid="running-note">
        Scheduled posts go out only while KLIPZ is running on this PC (it checks every 15 s). Anything that came due while it was off is published the next time you start it.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Filter by status" data-testid="filter-status">
          {FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
        <Select value={provider} onChange={(e) => setProvider(e.target.value as Provider | "all")} aria-label="Filter by platform" data-testid="filter-provider">
          <option value="all">All platforms</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_META[p].label}
            </option>
          ))}
        </Select>
        {batchParam ? (
          <Link href="/posts" className="inline-flex h-8 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-3 text-xs font-semibold text-accent-2">
            Showing one batch <X className="h-3 w-3" aria-hidden /> Show all
          </Link>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
          {anyLive && posts ? (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-good" aria-hidden /> Live
            </>
          ) : null}
        </span>
      </div>

      {error ? (
        <p role="alert" className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
      {!posts && !error ? <p className="text-sm text-muted">Loading…</p> : null}
      {posts && batches.length === 0 ? (
        <EmptyState title={visible.length === 0 ? "Nothing posted yet" : "No posts match these filters"}>
          {visible.length === 0 ? (
            <>
              Open a clip in a project and press <strong>Post</strong> on a rendered clip.{" "}
              <Link href="/" className="text-accent-2 underline">
                Go to projects
              </Link>
            </>
          ) : (
            "Clear a filter to see more."
          )}
        </EmptyState>
      ) : null}

      <div className="flex flex-col gap-5">
        {batches.map((b) => (
          <BatchCard key={b.batchId} posts={totalsByBatch.get(b.batchId) ?? b.posts} shown={b.posts} now={now} busyId={busyId} onAct={act} highlight={b.batchId === batchParam} />
        ))}
      </div>
      {node}
    </div>
  );
}

function BatchCard({
  posts,
  shown,
  now,
  busyId,
  onAct,
  highlight,
}: {
  posts: PostView[];
  shown: PostView[];
  now: number;
  busyId: string | null;
  onAct: (p: PostView, a: "retry" | "cancel" | "reschedule" | "delete", extra?: { scheduledAt?: string; caption?: string }) => Promise<boolean>;
  highlight: boolean;
}) {
  const ordered = [...shown].sort((a, b) => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider));
  const first = [...posts].sort((a, b) => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider))[0]!;
  const sum = summarizeBatch(posts);
  const cover = fileUrl(first.cover_key);
  const scheduledAt = posts.find((p) => p.scheduled_at)?.scheduled_at ?? null;
  const tz = posts.find((p) => p.timezone)?.timezone ?? browserTimeZone();
  const [coverOk, setCoverOk] = useState(true);
  return (
    <Card className={cn("overflow-hidden", highlight && "border-accent/60")} data-batch-id={first.batch_id} data-testid="batch">
      <div className="flex gap-4 border-b border-line p-4">
        {cover && coverOk ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="h-20 w-[45px] shrink-0 rounded-md bg-panel-2 object-cover" onError={() => setCoverOk(false)} />
        ) : (
          <div className="h-20 w-[45px] shrink-0 rounded-md bg-panel-2" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <Link href={`/clips/${first.clip_id}`} className="block truncate rounded font-bold hover:underline">
            {first.clip_title || "Untitled clip"}
          </Link>
          <p className="mt-0.5 line-clamp-2 text-sm text-muted">{first.caption || <em>No caption</em>}</p>
          <p className="mt-1 text-xs text-muted">
            {scheduledAt ? (
              <>
                <Clock className="mr-1 inline h-3 w-3" aria-hidden />
                Scheduled for {formatInZone(scheduledAt, tz)} <span className="opacity-70">({tz})</span>
              </>
            ) : (
              <>Created {new Date(first.created_at).toLocaleString()}</>
            )}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn("text-sm font-semibold", sum.failed ? "text-warn" : sum.done ? "text-good" : "text-fg")} data-testid="batch-summary">
            {sum.text}
          </p>
        </div>
      </div>
      <ul>
        {ordered.map((p) => (
          <PostRow key={p.id} post={p} now={now} busy={busyId === p.id} onAct={onAct} />
        ))}
      </ul>
    </Card>
  );
}

function PostRow({ post: p, now, busy, onAct }: { post: PostView; now: number; busy: boolean; onAct: (p: PostView, a: "retry" | "cancel" | "reschedule" | "delete", extra?: { scheduledAt?: string; caption?: string }) => Promise<boolean> }) {
  const meta = PROVIDER_META[p.provider];
  const [editing, setEditing] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixText, setFixText] = useState("");
  const canEditText = p.status === "failed" && (!p.external_id || p.error_code === "platform_failed");
  const tz = p.timezone ?? browserTimeZone();
  const [local, setLocal] = useState("");
  const startEdit = () => {
    setLocal(p.scheduled_at ? formatLocalValue(partsInZone(Date.parse(p.scheduled_at), tz)) : "");
    setEditing(true);
  };
  const check = editing ? checkSchedule(local, tz, new Date()) : null;
  const live = p.status === "queued" || p.status === "publishing" || p.status === "processing";

  return (
    <li className="flex min-h-[3.75rem] flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-2.5 last:border-b-0" data-provider={p.provider} data-status={p.status} data-testid="post-row">
      <div className="flex w-44 shrink-0 items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: meta.color }} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-bold leading-tight">{meta.label}</p>
          <p className="truncate text-xs text-muted">{p.account?.display_name ?? "Account disconnected"}</p>
        </div>
      </div>
      <div className="w-28 shrink-0">
        <Badge tone={TONE[p.status]} data-testid="post-status">
          {live ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
          {STATUS_LABEL[p.status]}
        </Badge>
      </div>
      <div className="min-w-[12rem] flex-1 text-sm">
        {p.status === "scheduled" && p.scheduled_at ? (
          <span className="tabular-nums">
            <strong>{formatCountdown(Date.parse(p.scheduled_at) - now)}</strong> <span className="text-muted">· {formatInZone(p.scheduled_at, tz)}</span>
          </span>
        ) : null}
        {p.status === "queued" ? <span className="text-muted">Waiting for the next scheduler tick{p.error ? ` · retrying after: ${p.error}` : ""}</span> : null}
        {p.status === "publishing" ? <span className="text-muted">Uploading…</span> : null}
        {p.status === "processing" ? <span className="text-muted">The platform is processing the video…</span> : null}
        {p.status === "published" ? (
          p.external_url ? (
            <a href={p.external_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded font-semibold text-accent-2 hover:underline" data-testid="post-link">
              View post <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          ) : (
            <span className="text-muted">Published (the platform did not return a link)</span>
          )
        ) : null}
        {p.status === "failed" ? (
          <div className="text-bad" role="status">
            <p className="break-words">{p.error ?? "Failed"}</p>
            <p className="text-xs text-muted">
              {p.error_code ? <code className="rounded bg-panel-2 px-1">{p.error_code}</code> : null} · attempt {p.attempts} of {p.max_attempts}
            </p>
          </div>
        ) : null}
        {p.status === "cancelled" ? <span className="text-muted">Cancelled</span> : null}
        {p.status === "published" && p.metrics ? (
          <span className="ml-3 text-xs text-muted tabular-nums">{p.metrics.views ?? 0} views</span>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
        {canEditText ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => (setFixText(p.caption), setFixing((v) => !v))} data-testid="edit-retry">
            Edit text
          </Button>
        ) : null}
        {p.status === "failed" ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onAct(p, "retry")} data-testid="retry">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
          </Button>
        ) : null}
        {p.status === "scheduled" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={startEdit}>
            Reschedule
          </Button>
        ) : null}
        {p.status === "scheduled" || p.status === "queued" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onAct(p, "cancel")} data-testid="cancel">
            <X className="h-3.5 w-3.5" aria-hidden /> Cancel
          </Button>
        ) : null}
        {p.status === "failed" || p.status === "cancelled" ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onAct(p, "delete")} aria-label={`Remove ${meta.label} entry`}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
      </div>
      {fixing && canEditText ? (
        <form
          className="flex w-full flex-col gap-2 rounded-lg border border-line bg-bg p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onAct(p, "retry", { caption: fixText })) setFixing(false);
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Caption sent to {meta.label} (edit it, then save and retry)
            <Textarea value={fixText} onChange={(e) => setFixText(e.target.value)} rows={3} data-testid="fix-caption" />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy} data-testid="fix-save">
              Save and retry
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setFixing(false)}>
              Close
            </Button>
          </div>
        </form>
      ) : null}
      {editing ? (
        <form
          className="flex w-full flex-wrap items-end gap-2 rounded-lg border border-line bg-bg p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!check?.ok || !check.utc) return;
            if (await onAct(p, "reschedule", { scheduledAt: check.utc.toISOString() })) setEditing(false);
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            New time ({tz})
            <Input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} className="w-56" />
          </label>
          <Button type="submit" size="sm" disabled={!check?.ok || busy}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Close
          </Button>
          {check && !check.ok ? (
            <p role="alert" className="w-full text-xs text-bad">
              {check.error}
            </p>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}
