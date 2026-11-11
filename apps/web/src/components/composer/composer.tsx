"use client";

import type { Clip, Provider, SocialAccount } from "@klipz/shared";
import { PROVIDERS } from "@klipz/shared";
import { AlertTriangle, ArrowLeft, Loader2, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/project/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Badge, Card, Input, Select, Switch, Textarea } from "@/components/ui/primitives";
import {
  buildPostRequest,
  defaultInstagram,
  defaultYouTube,
  emptyTikTokForm,
  overrideHasText,
  sanitizeTikTok,
  tiktokOptions,
  type ComposerState,
  type TikTokForm,
} from "@/lib/composer";
import { browserTimeZone, checkSchedule } from "@/lib/schedule";
import type { AiCaptionsResponse, IssueDto, ValidateResponse } from "@/lib/social-api";
import { PROVIDER_META, counterTone, formatHashtags, parseHashtags } from "@/lib/social-ui";
import { api, cn, fileUrl, formatDuration } from "@/lib/utils";
import type { RenderView } from "@/server/renders";
import { CoverPicker } from "./cover-picker";
import { SchedulePicker, type ScheduleValue } from "./schedule-picker";
import { TikTokPanel, useTikTokInfo } from "./tiktok-panel";

type Ov = { caption?: string; hashtagsText?: string; title?: string };
type Tab = "shared" | Provider;

interface Props {
  clip: Pick<Clip, "id" | "title" | "hook" | "edit_version" | "project_id">;
  renders: RenderView[];
  accounts: SocialAccount[];
  sandbox: boolean;
}

const TITLE_PROVIDERS: Provider[] = ["youtube", "facebook", "linkedin"];

export function Composer({ clip, renders, accounts, sandbox }: Props) {
  const router = useRouter();
  const ready = useMemo(() => renders.filter((r) => r.status === "ready" && r.storage_key), [renders]);
  const [renderId, setRenderId] = useState<string>(ready[0]?.id ?? "");
  const render = ready.find((r) => r.id === renderId) ?? null;

  const [selected, setSelected] = useState<string[]>([]);
  const [shared, setShared] = useState({ caption: clip.hook ?? clip.title ?? "", hashtagsText: "", title: clip.title ?? "" });
  const [overrides, setOverrides] = useState<Partial<Record<Provider, Ov>>>({});
  const [tab, setTab] = useState<Tab>("shared");
  const [cover, setCover] = useState<number | null>(null);
  const [schedule, setSchedule] = useState<ScheduleValue>({ mode: "now", local: "", timezone: "UTC" });
  const [tt, setTt] = useState<TikTokForm>(emptyTikTokForm);
  const [yt, setYt] = useState(defaultYouTube);
  const [ig, setIg] = useState(defaultInstagram);
  const [xLong, setXLong] = useState(false);
  const [liVis, setLiVis] = useState<"PUBLIC" | "CONNECTIONS">("PUBLIC");

  const [validation, setValidation] = useState<ValidateResponse | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<Record<string, IssueDto[]> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [ai, setAi] = useState<{ busy: boolean; result: AiCaptionsResponse | null; error: string | null }>({ busy: false, result: null, error: null });
  const [aiConflict, setAiConflict] = useState<{ result: AiCaptionsResponse; providers: Provider[] } | null>(null);

  // Browser time zone only exists on the client; set it after mount to avoid a hydration mismatch.
  useEffect(() => {
    setSchedule((s) => (s.timezone === "UTC" ? { ...s, timezone: browserTimeZone() } : s));
  }, []);

  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const selAccounts = useMemo(() => selected.map((id) => byId.get(id)).filter((a): a is SocialAccount => Boolean(a)), [selected, byId]);
  const selProviders = useMemo(() => PROVIDERS.filter((p) => selAccounts.some((a) => a.provider === p)), [selAccounts]);
  const firstTikTok = selAccounts.find((a) => a.provider === "tiktok") ?? null;
  const tiktok = useTikTokInfo(firstTikTok?.id ?? null);

  // Keep the TikTok form consistent with the creator's settings once they load.
  useEffect(() => {
    if (tiktok.info) setTt((f) => sanitizeTikTok(f, tiktok.info!.creatorInfo));
  }, [tiktok.info]);

  // The active tab must exist.
  useEffect(() => {
    if (tab !== "shared" && !selProviders.includes(tab)) setTab("shared");
  }, [tab, selProviders]);

  const options = useMemo<ComposerState["options"]>(
    () => ({
      youtube: { privacyStatus: yt.privacyStatus, madeForKids: yt.madeForKids },
      instagram: { shareToFeed: ig.shareToFeed },
      tiktok: tiktokOptions(tt, tiktok.info?.creatorInfo ?? null),
      x: { longVideo: xLong },
      linkedin: { visibility: liVis },
    }),
    [yt, ig, tt, tiktok.info, xLong, liVis],
  );

  const sched = schedule.mode === "schedule" ? checkSchedule(schedule.local, schedule.timezone, new Date()) : null;

  const request = useMemo(() => {
    if (!render || selAccounts.length === 0) return null;
    return buildPostRequest({
      clipId: clip.id,
      renderId: render.id,
      accounts: selAccounts.map((a) => ({ id: a.id, provider: a.provider })),
      shared,
      overrides,
      options,
      coverTimestampMs: cover,
      schedule: sched?.ok && sched.utc ? { scheduledAt: sched.utc.toISOString(), timezone: schedule.timezone } : null,
      timezone: schedule.timezone,
    });
    // `sched` is derived from schedule; depend on its inputs so the memo stays stable between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render, selAccounts, shared, overrides, options, cover, clip.id, schedule.mode, schedule.local, schedule.timezone]);

  // Debounced server-side validation (caption counters, limits, per-platform rules).
  const reqKey = request ? JSON.stringify({ ...request, scheduledAt: undefined }) : "";
  const seq = useRef(0);
  useEffect(() => {
    if (!request) {
      setValidation(null);
      setValidating(false);
      return;
    }
    setValidating(true);
    const mine = ++seq.current;
    const id = setTimeout(async () => {
      try {
        const body = { ...request };
        delete body.scheduledAt;
        const v = await api<ValidateResponse>("/api/posts/validate", { method: "POST", json: body });
        if (seq.current !== mine) return;
        setValidation(v);
        setValidationError(null);
        setServerIssues(null);
      } catch (e) {
        if (seq.current !== mine) return;
        setValidation(null);
        setValidationError(e instanceof Error ? e.message : "Validation failed");
      } finally {
        if (seq.current === mine) setValidating(false);
      }
    }, 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  const issuesFor = (accountId: string): IssueDto[] => (serverIssues ?? validation?.issues)?.[accountId] ?? [];
  const providerIssues = (p: Provider): IssueDto[] => {
    const seen = new Set<string>();
    const out: IssueDto[] = [];
    for (const a of selAccounts.filter((x) => x.provider === p)) {
      for (const i of issuesFor(a.id)) {
        const k = `${i.severity}|${i.field}|${i.message}`;
        if (!seen.has(k)) (seen.add(k), out.push(i));
      }
    }
    return out;
  };
  const errorCount = selProviders.reduce((n, p) => n + providerIssues(p).filter((i) => i.severity === "error").length, 0);
  const composedFor = (p: Provider) => {
    const a = selAccounts.find((x) => x.provider === p);
    return a ? validation?.composed[a.id] : undefined;
  };

  // ── editing helpers ───────────────────────────────────────────────────
  const setOverride = (p: Provider, patch: Ov) =>
    setOverrides((prev) => {
      const cur: Ov = { ...prev[p], ...patch };
      if (cur.caption !== undefined && cur.caption === shared.caption) delete cur.caption;
      if (cur.hashtagsText !== undefined && formatHashtags(parseHashtags(cur.hashtagsText)) === formatHashtags(parseHashtags(shared.hashtagsText))) delete cur.hashtagsText;
      if (cur.title !== undefined && cur.title === shared.title) delete cur.title;
      const next = { ...prev };
      if (Object.keys(cur).length) next[p] = cur;
      else delete next[p];
      return next;
    });
  const clearOverride = (p: Provider) =>
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[p];
      return next;
    });

  const toggleAccount = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // ── AI captions ───────────────────────────────────────────────────────
  const applyAi = (result: AiCaptionsResponse, providers: Provider[]) =>
    setOverrides((prev) => {
      const next = { ...prev };
      for (const p of providers) {
        const c = result.captions[p];
        if (!c) continue;
        const ov: Ov = { caption: c.caption, hashtagsText: formatHashtags(c.hashtags) };
        if (c.title) ov.title = c.title;
        next[p] = ov;
      }
      return next;
    });

  const generate = async (providers: Provider[]) => {
    if (providers.length === 0) return;
    setAi((s) => ({ ...s, busy: true, error: null }));
    try {
      const result = await api<AiCaptionsResponse>("/api/ai/captions", { method: "POST", json: { clipId: clip.id, providers } });
      setAi({ busy: false, result, error: null });
      const withText = providers.filter((p) => result.captions[p] && overrideHasText(overrides[p]));
      const free = providers.filter((p) => result.captions[p] && !withText.includes(p));
      applyAi(result, free); // nothing typed there: safe to fill
      if (withText.length) setAiConflict({ result, providers: withText });
    } catch (e) {
      setAi({ busy: false, result: null, error: e instanceof Error ? e.message : "Caption generation failed" });
    }
  };

  // ── submit ────────────────────────────────────────────────────────────
  const blockers: string[] = [];
  if (!render) blockers.push("No finished render to post.");
  if (selAccounts.length === 0) blockers.push("Tick at least one account.");
  if (validationError) blockers.push(validationError);
  if (errorCount > 0) blockers.push(`${errorCount} problem${errorCount === 1 ? "" : "s"} to fix (see the platform tabs).`);
  if (sched && !sched.ok) blockers.push(sched.error ?? "Fix the schedule.");
  if (firstTikTok && tiktok.error) blockers.push("TikTok creator info could not be loaded.");
  const canSubmit = blockers.length === 0 && !validating && !submitting && request !== null;

  const submit = async () => {
    if (!request) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const data = (await res.json().catch(() => ({}))) as { batchId?: string; error?: string; issues?: Record<string, IssueDto[]> };
      if (!res.ok || !data.batchId) {
        if (data.issues) setServerIssues(data.issues);
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      router.push(`/posts?batch=${data.batchId}`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Could not create the posts");
      setSubmitting(false);
    }
  };

  const scheduled = schedule.mode === "schedule";
  const videoUrl = render ? fileUrl(render.storage_key) : null;
  const activeAccounts = accounts.filter((a) => a.status === "active");

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
      <header className="flex flex-wrap items-start gap-3">
        <Link href={`/projects/${clip.project_id}`} className="mt-1 rounded text-muted hover:text-fg" aria-label="Back to project">
          <ArrowLeft className="h-5 w-5" aria-hidden />
        </Link>
        <div>
          <h1 className="text-2xl font-black tracking-tight">Post clip</h1>
          <p className="text-sm text-muted">{clip.title || "Untitled clip"}</p>
        </div>
        {sandbox ? <Badge tone="warn" className="ml-auto">Sandbox: nothing is posted for real</Badge> : null}
      </header>

      {!render ? (
        <Card className="flex flex-col items-start gap-3 p-5" data-testid="no-render">
          <p className="font-semibold">This clip has no finished render yet.</p>
          <p className="text-sm text-muted">Export it in the editor first, then come back here to post it.</p>
          <Link href={`/clips/${clip.id}`} className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-2">
            Open the editor to export
          </Link>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-5">
            {/* Accounts */}
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="font-bold">1 · Accounts</h2>
                {activeAccounts.length > 0 ? (
                  <button type="button" onClick={() => setSelected(selected.length === activeAccounts.length ? [] : activeAccounts.map((a) => a.id))} className="cursor-pointer rounded text-xs font-semibold text-accent-2 hover:underline">
                    {selected.length === activeAccounts.length ? "Clear all" : "Select all connected"}
                  </button>
                ) : null}
              </div>
              {accounts.length === 0 ? (
                <p className="text-sm text-muted">
                  No accounts connected yet.{" "}
                  <Link href="/accounts" className="text-accent-2 underline">
                    Connect one
                  </Link>
                  .
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
                  {PROVIDERS.filter((p) => accounts.some((a) => a.provider === p)).map((p) => (
                    <fieldset key={p}>
                      <legend className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: PROVIDER_META[p].color }} aria-hidden />
                        {PROVIDER_META[p].label}
                      </legend>
                      {accounts
                        .filter((a) => a.provider === p)
                        .map((a) => {
                          const bad = a.status !== "active";
                          return (
                            <label key={a.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm", bad ? "opacity-70" : "cursor-pointer hover:bg-panel-2")}>
                              <input type="checkbox" checked={selected.includes(a.id)} disabled={bad} onChange={() => toggleAccount(a.id)} data-testid={`acct-${a.provider}`} />
                              <span className="min-w-0 flex-1 truncate">
                                {a.display_name} <span className="text-muted">{a.username ? `@${a.username.replace(/^@/, "")}` : ""}</span>
                              </span>
                              {bad ? (
                                <Link href="/accounts" className="shrink-0 rounded text-xs font-semibold text-warn underline">
                                  Reconnect
                                </Link>
                              ) : null}
                            </label>
                          );
                        })}
                    </fieldset>
                  ))}
                </div>
              )}
            </Card>

            {/* Text */}
            <Card className="p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="font-bold">2 · Caption &amp; options</h2>
                <Button size="sm" variant="secondary" className="ml-auto" disabled={selProviders.length === 0 || ai.busy} onClick={() => void generate(selProviders)} data-testid="ai-all">
                  {ai.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />} Generate with AI for all
                </Button>
              </div>
              {ai.result ? (
                <p className="mb-3 text-xs text-muted" data-testid="ai-info">
                  Generated by{" "}
                  <strong className="text-fg">{ai.result.generator === "claude" ? `Claude${ai.result.model ? ` (${ai.result.model})` : ""}` : "the offline heuristic generator"}</strong>
                  {ai.result.note ? ` · ${ai.result.note}` : ""}. It fills the platform tabs; your shared text is never touched.
                </p>
              ) : null}
              {ai.error ? (
                <p role="alert" className="mb-3 text-xs text-bad">
                  {ai.error}
                </p>
              ) : null}

              <div role="tablist" aria-label="Caption scope" className="mb-4 flex flex-wrap gap-1 border-b border-line">
                {(["shared", ...selProviders] as Tab[]).map((t) => {
                  const active = tab === t;
                  const errs = t === "shared" ? 0 : providerIssues(t).filter((i) => i.severity === "error").length;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      id={`tab-${t}`}
                      aria-controls="tabpanel"
                      onClick={() => setTab(t)}
                      className={cn("-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold", active ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}
                    >
                      {t === "shared" ? "Shared" : (
                        <>
                          <span className="h-2 w-2 rounded-full" style={{ background: PROVIDER_META[t].color }} aria-hidden />
                          {PROVIDER_META[t].label}
                        </>
                      )}
                      {t !== "shared" && overrideHasText(overrides[t]) ? <span className="rounded bg-accent/20 px-1 text-[10px] text-accent-2">custom</span> : null}
                      {errs > 0 ? <span className="rounded bg-bad/20 px-1 text-[10px] text-bad" aria-label={`${errs} errors`}>{errs}</span> : null}
                    </button>
                  );
                })}
              </div>

              <div role="tabpanel" id="tabpanel" aria-labelledby={`tab-${tab}`} className="flex flex-col gap-4">
                {tab === "shared" ? (
                  <>
                    <TextFields
                      idp="shared"
                      caption={shared.caption}
                      hashtagsText={shared.hashtagsText}
                      title={shared.title}
                      showTitle
                      titleHint="Used by YouTube, Facebook and LinkedIn."
                      onCaption={(v) => setShared((s) => ({ ...s, caption: v }))}
                      onHashtags={(v) => setShared((s) => ({ ...s, hashtagsText: v }))}
                      onTitle={(v) => setShared((s) => ({ ...s, title: v }))}
                    />
                    {selProviders.length > 0 ? (
                      <div className="flex flex-wrap gap-2" aria-label="Character counters per platform">
                        {selProviders.map((p) => (
                          <Counter key={p} label={PROVIDER_META[p].label} composed={composedFor(p)} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted">Tick accounts above to see per-platform counters and options.</p>
                    )}
                  </>
                ) : (
                  <ProviderTab
                    provider={tab}
                    shared={shared}
                    ov={overrides[tab]}
                    composed={composedFor(tab)}
                    issues={providerIssues(tab)}
                    onOverride={(patch) => setOverride(tab, patch)}
                    onReset={() => clearOverride(tab)}
                    onGenerate={() => void generate([tab])}
                    aiBusy={ai.busy}
                  >
                    {tab === "youtube" ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                          Visibility
                          <Select value={yt.privacyStatus} onChange={(e) => setYt({ ...yt, privacyStatus: e.target.value as typeof yt.privacyStatus })} data-testid="yt-privacy">
                            <option value="public">Public</option>
                            <option value="unlisted">Unlisted</option>
                            <option value="private">Private</option>
                          </Select>
                        </label>
                        <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                          <div>
                            <p className="text-sm font-semibold">Made for kids</p>
                            <p className="text-xs text-muted">Required by YouTube. Turns off comments and some features.</p>
                          </div>
                          <Switch checked={yt.madeForKids} onChange={(v) => setYt({ ...yt, madeForKids: v })} label="Made for kids" />
                        </div>
                      </div>
                    ) : null}
                    {tab === "instagram" ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                        <div>
                          <p className="text-sm font-semibold">Also share to feed</p>
                          <p className="text-xs text-muted">Show the Reel on your profile grid, not only in the Reels tab.</p>
                        </div>
                        <Switch checked={ig.shareToFeed} onChange={(v) => setIg({ ...ig, shareToFeed: v })} label="Share to feed" />
                      </div>
                    ) : null}
                    {tab === "x" ? (
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                        <div>
                          <p className="text-sm font-semibold">Long video (X Premium)</p>
                          <p className="text-xs text-muted">Allows videos longer than 140 s. Leave off unless the account has Premium.</p>
                        </div>
                        <Switch checked={xLong} onChange={setXLong} label="Long video" />
                      </div>
                    ) : null}
                    {tab === "linkedin" ? (
                      <label className="flex max-w-xs flex-col gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
                        Visibility
                        <Select value={liVis} onChange={(e) => setLiVis(e.target.value as typeof liVis)}>
                          <option value="PUBLIC">Public</option>
                          <option value="CONNECTIONS">Connections only</option>
                        </Select>
                      </label>
                    ) : null}
                    {tab === "facebook" ? <p className="text-xs text-muted">Posted as a Reel to the Page. No extra options.</p> : null}
                    {tab === "tiktok" ? <TikTokPanel state={tiktok} form={tt} onChange={setTt} durationSec={render.duration_sec ?? 0} accountCount={selAccounts.filter((a) => a.provider === "tiktok").length} /> : null}
                  </ProviderTab>
                )}
              </div>
            </Card>

            {/* Cover */}
            <Card className="p-4">
              <h2 className="mb-3 font-bold">3 · Cover frame</h2>
              {videoUrl ? <CoverPicker key={render.id} src={videoUrl} durationSec={render.duration_sec ?? 1} valueMs={cover} onChange={setCover} /> : null}
            </Card>

            {/* When */}
            <Card className="p-4">
              <h2 className="mb-3 font-bold">4 · When</h2>
              <SchedulePicker value={schedule} onChange={setSchedule} providers={selProviders} />
            </Card>
          </div>

          {/* Right rail */}
          <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:self-start" aria-label="Render and submit">
            <Card className="flex flex-col gap-3 p-4">
              <h2 className="font-bold">Render</h2>
              {videoUrl ? <video key={render.id} src={videoUrl} controls preload="metadata" playsInline className="mx-auto max-h-72 rounded-md bg-black" aria-label="Rendered clip preview" data-testid="preview-video" /> : null}
              {ready.length > 1 ? (
                <Select value={renderId} onChange={(e) => (setRenderId(e.target.value), setCover(null))} aria-label="Choose render" className="w-full">
                  {ready.map((r, i) => (
                    <option key={r.id} value={r.id}>
                      {i === 0 ? "Latest · " : ""}
                      {new Date(r.created_at).toLocaleString()}
                      {r.outdated ? " · outdated" : ""}
                    </option>
                  ))}
                </Select>
              ) : null}
              <p className="text-xs text-muted">
                {formatDuration(render.duration_sec)} · {render.width}×{render.height} · {render.fps ? `${Math.round(render.fps)} fps` : ""}
              </p>
              {render.outdated ? (
                <p role="alert" className="flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn" data-testid="outdated-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>
                    This render is older than your latest edits to the clip.{" "}
                    <Link href={`/clips/${clip.id}`} className="underline">
                      Open the editor
                    </Link>{" "}
                    to export a new one.
                  </span>
                </p>
              ) : null}
            </Card>

            <Card className="flex flex-col gap-3 p-4">
              <h2 className="font-bold">Ready to post?</h2>
              <p className="text-sm text-muted" aria-live="polite">
                {selAccounts.length === 0 ? "No accounts ticked." : `${selAccounts.length} account${selAccounts.length === 1 ? "" : "s"}: ${selProviders.map((p) => PROVIDER_META[p].label).join(", ")}`}
              </p>
              {blockers.length > 0 ? (
                <ul className="flex flex-col gap-1 text-xs text-bad" data-testid="blockers">
                  {blockers.map((b) => (
                    <li key={b}>• {b}</li>
                  ))}
                </ul>
              ) : null}
              {submitError ? (
                <p role="alert" className="text-xs text-bad" data-testid="submit-error">
                  {submitError}
                </p>
              ) : null}
              <Button size="lg" disabled={!canSubmit} onClick={() => void submit()} data-testid="submit-post">
                {submitting || validating ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
                {scheduled ? "Schedule" : "Post now"}
                {selAccounts.length ? ` · ${selAccounts.length}` : ""}
              </Button>
              {scheduled ? <p className="text-xs text-muted">Stays on this PC until the time comes; KLIPZ has to be running.</p> : null}
            </Card>
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={aiConflict !== null}
        title="Replace your text with AI suggestions?"
        confirmLabel="Replace my text"
        onConfirm={() => {
          if (aiConflict) applyAi(aiConflict.result, aiConflict.providers);
          setAiConflict(null);
        }}
        onCancel={() => setAiConflict(null)}
      >
        You already wrote custom text for {aiConflict?.providers.map((p) => PROVIDER_META[p].label).join(", ")}. Replacing it cannot be undone. Platforms where you typed nothing already received their suggestions.
      </ConfirmDialog>
    </div>
  );
}

function Counter({ label, composed }: { label: string; composed: { length: number; limit: number } | undefined }) {
  if (!composed) return <Badge>{label} …</Badge>;
  const tone = counterTone(composed.length, composed.limit);
  return (
    <Badge tone={tone === "over" ? "bad" : tone === "warn" ? "warn" : "default"} data-testid={`counter-${label.toLowerCase()}`}>
      {label} {composed.length.toLocaleString()} / {composed.limit.toLocaleString()}
    </Badge>
  );
}

function TextFields({
  idp,
  caption,
  hashtagsText,
  title,
  showTitle,
  titleHint,
  onCaption,
  onHashtags,
  onTitle,
}: {
  idp: string;
  caption: string;
  hashtagsText: string;
  title: string;
  showTitle: boolean;
  titleHint?: string;
  onCaption: (v: string) => void;
  onHashtags: (v: string) => void;
  onTitle: (v: string) => void;
}) {
  return (
    <>
      {showTitle ? (
        <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted" htmlFor={`${idp}-title`}>
          Title
          <Input id={`${idp}-title`} aria-label="Title" value={title} maxLength={300} onChange={(e) => onTitle(e.target.value)} data-testid={`${idp}-title`} />
          {titleHint ? <span className="font-normal normal-case tracking-normal">{titleHint}</span> : null}
        </label>
      ) : null}
      <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted" htmlFor={`${idp}-caption`}>
        Caption
        <Textarea id={`${idp}-caption`} aria-label="Caption" rows={4} value={caption} onChange={(e) => onCaption(e.target.value)} placeholder="What is this clip about?" data-testid={`${idp}-caption`} />
      </label>
      <label className="flex flex-col gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted" htmlFor={`${idp}-tags`}>
        Hashtags
        <Input id={`${idp}-tags`} aria-label="Hashtags" value={hashtagsText} onChange={(e) => onHashtags(e.target.value)} placeholder="#shorts #podcast" data-testid={`${idp}-tags`} />
      </label>
    </>
  );
}

function ProviderTab({
  provider,
  shared,
  ov,
  composed,
  issues,
  onOverride,
  onReset,
  onGenerate,
  aiBusy,
  children,
}: {
  provider: Provider;
  shared: { caption: string; hashtagsText: string; title: string };
  ov: Ov | undefined;
  composed: { caption: string; length: number; limit: number; title?: string } | undefined;
  issues: IssueDto[];
  onOverride: (patch: Ov) => void;
  onReset: () => void;
  onGenerate: () => void;
  aiBusy: boolean;
  children?: React.ReactNode;
}) {
  const meta = PROVIDER_META[provider];
  const tone = composed ? counterTone(composed.length, composed.limit) : "ok";
  const hasOverride = Boolean(ov && Object.keys(ov).length);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted">
          {hasOverride ? `Custom text for ${meta.label}.` : `${meta.label} uses the shared text. Edit here to customise it for ${meta.label} only.`}
        </p>
        <div className="ml-auto flex gap-2">
          {hasOverride ? (
            <Button size="sm" variant="ghost" onClick={onReset}>
              Reset to shared
            </Button>
          ) : null}
          <Button size="sm" variant="secondary" disabled={aiBusy} onClick={onGenerate} data-testid={`ai-${provider}`}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Generate for {meta.label}
          </Button>
        </div>
      </div>
      <TextFields
        idp={provider}
        caption={ov?.caption ?? shared.caption}
        hashtagsText={ov?.hashtagsText ?? shared.hashtagsText}
        title={ov?.title ?? shared.title}
        showTitle={TITLE_PROVIDERS.includes(provider)}
        {...(provider === "youtube" ? { titleHint: "Shown as the video title. YouTube allows up to 100 characters." } : {})}
        onCaption={(v) => onOverride({ caption: v })}
        onHashtags={(v) => onOverride({ hashtagsText: v })}
        onTitle={(v) => onOverride({ title: v })}
      />
      <div className="flex flex-col gap-1.5" aria-live="polite">
        <p className={cn("text-xs font-semibold tabular-nums", tone === "over" ? "text-bad" : tone === "warn" ? "text-warn" : "text-muted")} data-testid={`final-count-${provider}`}>
          {composed ? `Final text on ${meta.label}: ${composed.length.toLocaleString()} / ${composed.limit.toLocaleString()} characters` : "Checking…"}
        </p>
        {composed ? (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Preview exactly what will be sent</summary>
            <pre className="mt-1 whitespace-pre-wrap rounded-md border border-line bg-bg p-2 font-sans text-fg">
              {composed.title ? `Title: ${composed.title}\n\n` : ""}
              {composed.caption || "(empty)"}
            </pre>
          </details>
        ) : null}
      </div>
      {issues.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid={`issues-${provider}`}>
          {issues.map((i) => (
            <li key={`${i.field}-${i.code}-${i.message}`} className={cn("flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs", i.severity === "error" ? "border-bad/40 bg-bad/10 text-bad" : "border-warn/40 bg-warn/10 text-warn")}>
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                <span className="sr-only">{i.severity}: </span>
                {i.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </>
  );
}
