"use client";

import { Cpu, Loader2, Sparkles } from "lucide-react";
import { useRef } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { cn } from "@/lib/utils";

export type EngineChoiceValue = "builtin" | "manual";

/**
 * Asked once after the video(s) are imported: let KLIPZ pick the clips, or export the transcript and a
 * light copy for Gemini and paste its JSON back (Manual AI Mode). No close button: it is a real choice,
 * and both answers can be changed later on the project page.
 */
export function EngineChoice({ open, busy, onChoose }: { open: boolean; busy: EngineChoiceValue | null; onChoose: (v: EngineChoiceValue) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useFocusTrap(boxRef, open);
  if (!open) return null;
  const options = [
    {
      id: "builtin" as const,
      icon: Cpu,
      title: "Use Built-in Engine",
      text: "KLIPZ transcribes the video, finds the strongest moments and edits them for you. Works offline.",
    },
    {
      id: "manual" as const,
      icon: Sparkles,
      title: "Manual AI Mode",
      text: "Export the timestamped transcript and a tiny 360p copy for Gemini, then paste its JSON answer back. KLIPZ cuts the clips from the original video.",
    },
  ];
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" data-testid="engine-choice">
      <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby="engine-title" className="w-full max-w-xl rounded-xl border border-line bg-panel p-5 shadow-2xl">
        <h2 id="engine-title" className="text-lg font-bold">
          How should the clips be picked?
        </h2>
        <p className="mt-1 text-sm text-muted">Your video is ready. You can switch later on this page.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={busy !== null}
              onClick={() => onChoose(o.id)}
              data-engine={o.id}
              className={cn(
                "flex cursor-pointer flex-col gap-2 rounded-xl border border-line bg-bg p-4 text-left transition-colors hover:border-accent/70 disabled:cursor-wait disabled:opacity-70",
                busy === o.id && "border-accent",
              )}
            >
              <span className="flex items-center gap-2 font-bold">
                {busy === o.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <o.icon className="h-4 w-4 text-accent-2" />}
                {o.title}
              </span>
              <span className="text-xs text-muted">{o.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
