"use client";

import { Check, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/primitives";
import { api } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";

export function ProjectHeader({ projectId, title, onTitle }: { projectId: string; title: string; onTitle: (t: string) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function save() {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    const prev = title;
    onTitle(next);
    try {
      await api(`/api/projects/${projectId}`, { method: "PATCH", json: { title: next } });
      setError(null);
    } catch (e) {
      onTitle(prev);
      setDraft(prev);
      setError(e instanceof Error ? e.message : "Could not rename");
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api(`/api/projects/${projectId}`, { method: "DELETE" });
      router.push("/");
      router.refresh();
    } catch (e) {
      setDeleting(false);
      setConfirming(false);
      setError(e instanceof Error ? e.message : "Could not delete");
    }
  }

  return (
    <header className="flex flex-wrap items-center gap-3">
      {editing ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            aria-label="Project title"
            value={draft}
            maxLength={160}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(title);
                setEditing(false);
              }
            }}
            className="h-10 max-w-xl text-lg font-bold"
          />
          <Button type="submit" size="icon" variant="secondary" aria-label="Save title" onMouseDown={(e) => e.preventDefault()}>
            <Check className="h-4 w-4" aria-hidden />
          </Button>
        </form>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate text-2xl font-black tracking-tight">{title}</h1>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Rename project"
            onClick={() => {
              setDraft(title);
              setEditing(true);
            }}
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      )}
      <Button variant="danger" onClick={() => setConfirming(true)}>
        <Trash2 className="h-4 w-4" aria-hidden /> Delete project
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-sm text-bad">
          {error}
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming}
        title="Delete this project?"
        confirmLabel="Delete project"
        busy={deleting}
        onConfirm={() => void remove()}
        onCancel={() => setConfirming(false)}
      >
        The source video, every clip, renders and scheduled posts for &ldquo;{title}&rdquo; will be removed from this computer. This can&apos;t be undone.
      </ConfirmDialog>
    </header>
  );
}
