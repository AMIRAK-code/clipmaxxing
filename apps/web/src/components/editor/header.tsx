"use client";

import { ArrowLeft, CircleHelp, Download, Loader2, Check, AlertTriangle, CloudOff } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditorCtx, useSaveState } from "./editor-context";

export function SaveStatus() {
  const s = useSaveState();
  const map = {
    saved: { label: "Saved", icon: <Check className="h-3.5 w-3.5" aria-hidden />, cls: "text-good" },
    saving: { label: "Saving…", icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />, cls: "text-muted" },
    dirty: { label: "Unsaved changes", icon: <CloudOff className="h-3.5 w-3.5" aria-hidden />, cls: "text-warn" },
    error: { label: "Save failed, retrying", icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden />, cls: "text-bad" },
    conflict: { label: "Conflict: newer version loaded", icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden />, cls: "text-warn" },
  } as const;
  const m = map[s.status];
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="save-status"
      data-status={s.status}
      title={s.message ?? m.label}
      className={cn("inline-flex min-w-[9.5rem] items-center gap-1.5 text-xs font-semibold", m.cls)}
    >
      {m.icon}
      {m.label}
    </span>
  );
}

export function EditorHeader({ onExport }: { onExport: () => void }) {
  const { clip, saveNow, showHelp } = useEditorCtx();
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
      <Link
        href={`/projects/${clip.projectId}`}
        aria-label="Back to project"
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-panel-2 hover:text-fg"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-sm font-bold">{clip.title || "Untitled clip"}</h1>
      <SaveStatus />
      <Button size="sm" variant="ghost" onClick={() => void saveNow()} aria-label="Save now (Ctrl+S)" title="Save now (Ctrl+S)">
        Save
      </Button>
      <Button size="iconSm" variant="ghost" onClick={showHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        <CircleHelp className="h-4 w-4" aria-hidden />
      </Button>
      <Button size="sm" onClick={onExport} aria-label="Export">
        <Download className="h-3.5 w-3.5" aria-hidden /> Export
      </Button>
    </header>
  );
}
