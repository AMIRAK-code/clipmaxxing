"use client";

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { SHORTCUT_HELP } from "@/lib/editor/shortcuts";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label="Keyboard shortcuts"
      className="m-auto w-[min(34rem,92vw)] rounded-xl border border-line bg-panel p-0 text-fg backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-bold">Keyboard shortcuts</h2>
        <Button size="iconSm" variant="ghost" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <dl className="grid grid-cols-[11rem_1fr] gap-x-4 gap-y-2 px-4 py-3 text-sm">
        {SHORTCUT_HELP.map((s) => (
          <div key={s.keys} className="contents">
            <dt>
              <kbd className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-xs">{s.keys}</kbd>
            </dt>
            <dd className="text-muted">{s.label}</dd>
          </div>
        ))}
      </dl>
    </dialog>
  );
}
