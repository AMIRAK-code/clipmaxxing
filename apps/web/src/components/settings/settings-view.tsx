"use client";

import type { Job } from "@klipz/shared";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/project/confirm-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { Badge, Card, Input } from "@/components/ui/primitives";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { JOB_LABEL } from "@/hooks/use-jobs";
import { api, cn, formatBytes } from "@/lib/utils";
import type { SystemStatus } from "@/server/data-admin";

interface StatusResponse {
  status: SystemStatus;
  logTail: string[];
}

const KEY_LABEL: Record<string, string> = {
  ANTHROPIC_API_KEY: "Anthropic (Claude scoring and captions)",
  ELEVENLABS_API_KEY: "ElevenLabs (voiceover)",
  AGGREGATOR_API_KEY: "Upload-Post / Ayrshare aggregator",
  TOKEN_ENCRYPTION_KEY: "Token encryption key (otherwise auto-generated in the data folder)",
  OAUTH_STATE_SECRET: "OAuth state secret (otherwise auto-generated in the data folder)",
  OLLAMA_MODEL: "Ollama model (local scoring)",
  LLM_PROVIDER: "LLM provider override",
};

export function SettingsView() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState<Job[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const { toast, node } = useToast();

  const load = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([api<StatusResponse>("/api/system/status"), api<{ jobs: Job[] }>("/api/jobs")]);
      setData(s);
      setDead(j.jobs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load settings");
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      toast("success", await fn());
      await load();
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  };

  const s = data?.status;
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex items-start gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Settings</h1>
          <p className="text-sm text-muted">System status, failed jobs, storage and your data.</p>
        </div>
        <Button variant="ghost" className="ml-auto" onClick={() => void load()} aria-label="Refresh status">
          <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
        </Button>
      </header>

      {error ? (
        <p role="alert" className="rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad">
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className="text-sm text-muted">Loading…</p> : null}

      {s ? (
        <Card className="p-4" data-testid="system-status">
          <h2 className="mb-3 font-bold">System status</h2>
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 text-sm sm:grid-cols-[11rem_1fr]">
            <dt className="text-muted">Worker</dt>
            <dd data-testid="worker-status">
              <span className="inline-flex items-center gap-1.5 font-semibold">
                {s.worker.online ? <CheckCircle2 className="h-4 w-4 text-good" aria-hidden /> : <XCircle className="h-4 w-4 text-bad" aria-hidden />}
                {s.worker.online ? "Online" : "Offline"}
              </span>
              {s.worker.online ? (
                <span className="ml-2 text-muted">
                  {s.worker.currentJob ? `running ${JOB_LABEL[s.worker.currentJob.type] ?? s.worker.currentJob.type}` : "idle"}
                </span>
              ) : (
                <span className="ml-2 text-muted">
                  Start KLIPZ with <code className="rounded bg-panel-2 px-1">npm start</code> (or double-click <code className="rounded bg-panel-2 px-1">start-klipz.bat</code>); the worker alone: <code className="rounded bg-panel-2 px-1">npm run worker</code>. {s.worker.error ? `(${s.worker.error})` : ""}
                </span>
              )}
              {s.worker.handlers.length > 0 ? (
                <p className="mt-1 flex flex-wrap gap-1">
                  {s.worker.handlers.map((h) => (
                    <Badge key={h}>{h}</Badge>
                  ))}
                </p>
              ) : null}
            </dd>
            <dt className="text-muted">ffmpeg</dt>
            <dd>
              {s.ffmpeg.ok ? (
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-4 w-4 text-good" aria-hidden /> version {s.ffmpeg.version}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-bad">
                  <XCircle className="h-4 w-4" aria-hidden /> Not found. Set FFMPEG_PATH or reinstall the worker venv.
                </span>
              )}
            </dd>
            <dt className="text-muted">Node.js</dt>
            <dd>{s.node}</dd>
            <dt className="text-muted">Data folder</dt>
            <dd>
              <code className="break-all rounded bg-panel-2 px-1">{s.dataDir}</code>
            </dd>
            <dt className="text-muted">Media storage</dt>
            <dd>
              {formatBytes(s.storage.bytes)} <span className="text-muted">in {s.storage.files.toLocaleString()} files</span>
            </dd>
            <dt className="text-muted">Database</dt>
            <dd>{formatBytes(s.dbBytes)}</dd>
            <dt className="text-muted">Highlight scorer</dt>
            <dd data-testid="llm-scorer">{s.llmScorer}</dd>
            <dt className="text-muted">Posting mode</dt>
            <dd>{s.sandbox ? <Badge tone="warn">Sandbox: nothing is posted for real</Badge> : <Badge tone="good">Live</Badge>}</dd>
            <dt className="text-muted">Optional keys</dt>
            <dd>
              <ul className="flex flex-col gap-1">
                {Object.entries(s.keys).map(([k, set]) => (
                  <li key={k} className="flex items-center gap-2">
                    <Badge tone={set ? "good" : "default"}>{set ? "set" : "not set"}</Badge>
                    <span className="text-muted">
                      <code className="text-fg">{k}</code> · {KEY_LABEL[k] ?? ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">Only whether a key exists is shown, never its value. Put keys in <code className="rounded bg-panel-2 px-1">.env.local</code> at the repo root (read by web and worker); <code className="rounded bg-panel-2 px-1">apps/web/.env.local</code> also works for the web app and wins.</p>
            </dd>
          </dl>
        </Card>
      ) : null}

      <Card className="overflow-hidden" data-testid="dlq">
        <div className="p-4 pb-2">
          <h2 className="font-bold">Failed jobs (dead-letter queue)</h2>
          <p className="text-sm text-muted">Jobs that ran out of retries. Retry gives them a fresh attempt budget; Delete removes the entry.</p>
        </div>
        {dead && dead.length === 0 ? <p className="px-4 pb-4 text-sm text-muted" data-testid="dlq-empty">No failed jobs. Nothing needs attention.</p> : null}
        {dead && dead.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y border-line text-left text-xs text-muted">
                  <th scope="col" className="px-4 py-2 font-semibold">Job</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Error</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">Attempts</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Last update</th>
                  <th scope="col" className="px-4 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {dead.map((j) => (
                  <tr key={j.id} className="border-b border-line align-top last:border-b-0" data-job-id={j.id}>
                    <td className="px-4 py-2.5">
                      <p className="font-semibold">{JOB_LABEL[j.type] ?? j.type}</p>
                      <Badge tone={j.status === "dead" ? "bad" : "warn"}>{j.status}</Badge>
                    </td>
                    <td className="max-w-md px-3 py-2.5 text-bad">
                      <p className="line-clamp-3 break-words">{j.error ?? "No error recorded"}</p>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {j.attempts}/{j.max_attempts}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted">{new Date(j.updated_at).toLocaleString()}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void run(`retry:${j.id}`, async () => (await api(`/api/jobs/${j.id}`, { method: "POST", json: { action: "retry" } }), "Job queued again."))}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Retry
                      </Button>{" "}
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void run(`del:${j.id}`, async () => (await api(`/api/jobs/${j.id}`, { method: "DELETE" }), "Entry deleted."))} aria-label={`Delete ${JOB_LABEL[j.type] ?? j.type} job`}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>

      <Card className="p-4">
        <h2 className="font-bold">Storage</h2>
        <p className="mt-1 text-sm text-muted">
          Source videos are kept for 30 days after import, then their media files are removed automatically (clips, renders and transcripts stay). Cleanup also drops stale partial uploads and old finished jobs.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="secondary" disabled={busy !== null} onClick={() => void run("cleanup", async () => (await api("/api/system/cleanup", { method: "POST" }), "Cleanup queued. The worker runs it next."))} data-testid="run-cleanup">
            {busy === "cleanup" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />} Run cleanup now
          </Button>
          {s && !s.worker.online ? <span className="text-xs text-warn">The worker is offline, so the job waits until it starts.</span> : null}
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="font-bold">Error log</h2>
        <p className="mt-1 text-sm text-muted">
          Server and browser errors are written to <code className="rounded bg-panel-2 px-1">{s ? `${s.dataDir}\\logs\\web.log` : "logs/web.log"}</code> in the data folder ({s ? formatBytes(s.logBytes) : "…"}, rotated at about 5 MB). Newest entries:
        </p>
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 text-xs text-muted" data-testid="log-tail">
          {data && data.logTail.length > 0 ? data.logTail.join("\n") : "No errors logged."}
        </pre>
      </Card>

      <Card className="border-bad/40 p-4" data-testid="danger-zone">
        <h2 className="flex items-center gap-2 font-bold text-bad">
          <AlertTriangle className="h-4 w-4" aria-hidden /> Danger zone
        </h2>
        <div className="mt-3 flex flex-col divide-y divide-line">
          <div className="flex flex-wrap items-center gap-3 py-3 first:pt-0">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Disconnect all accounts</p>
              <p className="text-sm text-muted">Deletes every stored social token. Post history stays, scheduled posts will fail until you reconnect.</p>
            </div>
            <Button variant="danger" onClick={() => setConfirmDisconnect(true)} disabled={busy !== null}>
              Disconnect all
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 py-3 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Delete all my data</p>
              <p className="text-sm text-muted">Disconnects accounts, removes every project, clip, render, post and job, and empties the media storage folder. KLIPZ keeps working, empty. This cannot be undone.</p>
            </div>
            <Button variant="danger" onClick={() => setConfirmWipe(true)} disabled={busy !== null} data-testid="delete-all">
              Delete all my data
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmDisconnect}
        title="Disconnect all accounts?"
        confirmLabel="Disconnect all"
        busy={busy === "disconnect"}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() =>
          void run("disconnect", async () => {
            const r = await api<{ disconnected: number }>("/api/accounts/disconnect-all", { method: "POST" });
            setConfirmDisconnect(false);
            return `${r.disconnected} account${r.disconnected === 1 ? "" : "s"} disconnected.`;
          }).finally(() => setConfirmDisconnect(false))
        }
      >
        Every connected platform account loses its stored tokens. You can connect them again from the Accounts page.
      </ConfirmDialog>

      <TypedConfirm
        open={confirmWipe}
        busy={busy === "wipe"}
        onCancel={() => setConfirmWipe(false)}
        onConfirm={() =>
          void run("wipe", async () => {
            const r = await api<{ result: { accountsDisconnected: number; storageEntriesRemoved: number } }>("/api/system/delete-all", { method: "POST", json: { confirm: "DELETE" } });
            setConfirmWipe(false);
            return `All data deleted (${r.result.accountsDisconnected} accounts disconnected, ${r.result.storageEntriesRemoved} storage entries removed).`;
          }).finally(() => setConfirmWipe(false))
        }
      />
      {node}
    </div>
  );
}

function TypedConfirm({ open, busy, onConfirm, onCancel }: { open: boolean; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusTrap(formRef, open);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (!open) return;
    setText("");
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  const ok = text === "DELETE";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wipe-title"
        className="w-full max-w-md rounded-xl border border-bad/40 bg-panel p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) onConfirm();
        }}
      >
        <h2 id="wipe-title" className="text-lg font-bold text-bad">
          Delete all my data?
        </h2>
        <p className="mt-2 text-sm text-muted">
          Every project, clip, render, post, job and connected account is deleted, and the media folder is emptied. Posts already published stay on the platforms. Type <strong className="text-fg">DELETE</strong> to confirm.
        </p>
        <Input ref={ref} value={text} onChange={(e) => setText(e.target.value)} aria-label="Type DELETE to confirm" autoComplete="off" spellCheck={false} className={cn("mt-3", ok && "border-bad")} data-testid="wipe-input" />
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!ok || busy} data-testid="wipe-confirm">
            {busy ? "Deleting…" : "Delete everything"}
          </Button>
        </div>
      </form>
    </div>
  );
}
