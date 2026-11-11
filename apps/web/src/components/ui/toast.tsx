"use client";

import { AlertTriangle, Check, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type ToastKind = "success" | "error" | "info";

/** Minimal toast: one message at a time, announced politely, auto-dismisses (errors stay longer). */
export function useToast(): { toast: (kind: ToastKind, text: string) => void; node: React.ReactNode } {
  const [t, setT] = useState<{ kind: ToastKind; text: string; id: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useCallback((kind: ToastKind, text: string) => {
    clearTimeout(timer.current);
    const id = Date.now();
    setT({ kind, text, id });
    timer.current = setTimeout(() => setT((cur) => (cur?.id === id ? null : cur)), kind === "error" ? 9000 : 5000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const node = (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col items-end" role="status" aria-live="polite">
      {t ? (
        <div
          data-testid="toast"
          data-kind={t.kind}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-lg border bg-panel px-3 py-2 text-sm shadow-xl",
            t.kind === "success" ? "border-good/40" : t.kind === "error" ? "border-bad/40" : "border-line",
          )}
        >
          {t.kind === "success" ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-hidden /> : t.kind === "error" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-hidden /> : null}
          <span className="min-w-0 break-words">{t.text}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setT(null)} className="ml-1 cursor-pointer rounded text-muted hover:text-fg">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : null}
    </div>
  );
  return { toast, node };
}
