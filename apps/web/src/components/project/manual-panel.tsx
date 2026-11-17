"use client";

import type { Job } from "@klipz/shared";
import { AlertTriangle, Check, ClipboardCopy, Download, FileText, FolderOpen, Loader2, RefreshCw, Sparkles, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, Progress, Textarea } from "@/components/ui/primitives";
import { api, fileUrl, formatBytes } from "@/lib/utils";

const ACTIVE = new Set(["queued", "running"]);

interface ManualFile {
  name: string;
  key: string;
  sizeBytes: number;
}

/**
 * Manual AI Mode on the project page: the files for Gemini (download / open folder / copy prompt), then a
 * box for the JSON it answers with and the button that turns it into clips.
 */
export function ManualPanel({ projectId, jobs, onChange, onUseBuiltin }: { projectId: string; jobs: Job[]; onChange: () => void; onUseBuiltin: () => void }) {
  const [files, setFiles] = useState<ManualFile[]>([]);
  const [json, setJson] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const exportJob = jobs.find((j) => j.type === "manual_export");
  const exporting = exportJob && ACTIVE.has(exportJob.status) ? exportJob : null;
  const exportFailed = exportJob && (exportJob.status === "failed" || exportJob.status === "dead") ? exportJob : null;
  const clipsJob = jobs.find((j) => j.type === "manual_clips");
  const building = clipsJob && ACTIVE.has(clipsJob.status) ? clipsJob : null;
  const buildFailed = clipsJob && (clipsJob.status === "failed" || clipsJob.status === "dead") ? clipsJob : null;

  const load = useCallback(async () => {
    try {
      setFiles((await api<{ files: ManualFile[] }>(`/api/projects/${projectId}/manual`)).files);
    } catch {
      /* shown as "not ready" */
    }
  }, [projectId]);
  // reload the list whenever the export job changes state (it finishes in the background)
  useEffect(() => {
    void load();
  }, [load, exportJob?.status]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const exportFiles = () =>
    run("export", async () => {
      await api(`/api/projects/${projectId}/manual`, { method: "POST", json: { action: "export" } });
      onChange();
    });
  const openFolder = () =>
    run("open", async () => {
      await api(`/api/projects/${projectId}/manual`, { method: "POST", json: { action: "open" } });
    });
  const copyPrompt = () =>
    run("copy", async () => {
      const prompt = files.find((f) => f.name === "gemini_prompt.txt");
      if (!prompt) throw new Error("The prompt is not ready yet");
      const text = await (await fetch(fileUrl(prompt.key)!)).text();
      await navigator.clipboard.writeText(text);
      setNotice("Prompt copied. Paste it into Gemini with the two files attached.");
    });
  const generate = () =>
    run("generate", async () => {
      const r = await api<{ clips: number; warnings: string[] }>(`/api/projects/${projectId}/manual/clips`, { method: "POST", json: { json } });
      setWarnings(r.warnings);
      setNotice(`Making ${r.clips} clip${r.clips === 1 ? "" : "s"} from the original video. They appear below as they are ready.`);
      onChange();
    });

  const ready = files.length > 0 && !exporting;
  const icon = (name: string) => (name.endsWith(".mp4") ? Video : FileText);

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="manual-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent-2" aria-hidden />
        <h2 className="text-sm font-bold">Manual AI Mode</h2>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onUseBuiltin}>
          Use the built-in engine instead
        </Button>
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted">1 · Files for Gemini</h3>
        {exporting ? (
          <div className="flex flex-col gap-1.5" role="status">
            <Progress value={exporting.progress ?? 0} />
            <p className="text-xs text-muted">{exporting.status === "queued" ? "Waiting for the worker" : (exporting.stage ?? "Starting")}</p>
          </div>
        ) : null}
        {exportFailed && !exporting ? (
          <p role="alert" className="flex items-start gap-2 text-xs text-bad">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {exportFailed.error ?? "Preparing the files failed."}
          </p>
        ) : null}
        {ready ? (
          <>
            <ul className="flex flex-col gap-1.5">
              {files.map((f) => {
                const Icon = icon(f.name);
                return (
                  <li key={f.key} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
                    <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.name}</span>
                    <span className="text-xs text-muted">{formatBytes(f.sizeBytes)}</span>
                    <a href={fileUrl(f.key) ?? "#"} download={f.name} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-semibold text-accent-2 hover:bg-panel-2">
                      <Download className="h-3.5 w-3.5" /> Download
                    </a>
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void openFolder()} disabled={busy !== null}>
                <FolderOpen className="h-3.5 w-3.5" /> Open folder
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void copyPrompt()} disabled={busy !== null}>
                <ClipboardCopy className="h-3.5 w-3.5" /> Copy prompt
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void exportFiles()} disabled={busy !== null}>
                <RefreshCw className="h-3.5 w-3.5" /> Make them again
              </Button>
            </div>
            <p className="text-xs text-muted">
              Upload <span className="font-mono">video_transcript.txt</span> and the <span className="font-mono">video_light</span> video to Gemini,
              paste the prompt, and copy its whole answer.
            </p>
          </>
        ) : !exporting ? (
          <Button onClick={() => void exportFiles()} disabled={busy !== null} className="self-start">
            {busy === "export" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Prepare files for Gemini
          </Button>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted">2 · Gemini&apos;s answer</h3>
        <label htmlFor="gemini-json" className="text-sm font-semibold">
          Paste Gemini JSON Output Here
        </label>
        <Textarea
          id="gemini-json"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={'{\n  "clips": [\n    { "title": "...", "text_on_screen": "...", "segments": [{ "start": 12.4, "end": 19.8 }] }\n  ]\n}'}
          className="font-mono text-xs"
          data-testid="gemini-json"
        />
        <Button onClick={() => void generate()} disabled={busy !== null || !json.trim() || !!building} className="self-start" data-testid="generate-from-json">
          {busy === "generate" || building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Generate Clips from JSON
        </Button>
        {building ? (
          <div className="flex flex-col gap-1.5" role="status">
            <Progress value={building.progress ?? 0} />
            <p className="text-xs text-muted">{building.status === "queued" ? "Waiting for the worker" : (building.stage ?? "Starting")}</p>
          </div>
        ) : buildFailed ? (
          <p role="alert" className="flex items-start gap-2 text-xs text-bad">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {buildFailed.error ?? "Making the clips failed."}
          </p>
        ) : null}
      </section>

      {notice ? <p className="text-xs text-good">{notice}</p> : null}
      {warnings.length ? (
        <ul className="list-disc pl-5 text-xs text-warn">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-bad">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
