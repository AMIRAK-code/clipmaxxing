"use client";

import type { Clip } from "@klipz/shared";
import { Check, Pencil, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { BREAKDOWN_KEYS, clampScore, scoreTone, scorerLabel } from "@/lib/clip-ui";
import { cn, formatDuration } from "@/lib/utils";

const TONE_TEXT = { good: "text-good", warn: "text-warn", bad: "text-bad" } as const;
const TONE_BAR = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" } as const;

function Breakdown({ clip }: { clip: Clip }) {
  const b = clip.score_breakdown;
  if (!b) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-5 gap-2">
        {BREAKDOWN_KEYS.map((k) => {
          const v = clampScore(b[k]);
          return (
            <div key={k} className="min-w-0" title={`${k}: ${v}`}>
              <div className="h-1 overflow-hidden rounded-full bg-panel-2" role="img" aria-label={`${k} ${v} out of 100`}>
                <div className={cn("h-full rounded-full", TONE_BAR[scoreTone(v)])} style={{ width: `${v}%` }} />
              </div>
              <p className="mt-0.5 truncate text-[10px] uppercase tracking-wide text-muted">{k}</p>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted">Scored by {scorerLabel(b)}</p>
    </div>
  );
}

export function ClipCard({
  clip,
  rank,
  selected,
  onSelect,
  onStatus,
}: {
  clip: Clip;
  rank: number;
  selected: boolean;
  onSelect: () => void;
  onStatus: (status: Clip["status"]) => void;
}) {
  const score = clampScore(clip.score);
  const tone = scoreTone(clip.score);
  const len = clip.end_sec - clip.start_sec;
  const discarded = clip.status === "discarded";
  return (
    <article
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer gap-3 rounded-xl border bg-panel p-3 transition-colors",
        selected ? "border-accent ring-1 ring-accent/60" : "border-line hover:border-accent/40",
        discarded && "opacity-70",
      )}
      data-clip-id={clip.id}
    >
      <div className="flex w-12 shrink-0 flex-col items-center gap-0.5">
        <span className="text-xs font-semibold text-muted" aria-label={`Rank ${rank}`}>
          #{rank}
        </span>
        <span className={cn("text-2xl font-black tabular-nums leading-none", clip.score == null ? "text-muted" : TONE_TEXT[tone])} aria-label={`Score ${score} out of 100`}>
          {clip.score == null ? "–" : score}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <button
            type="button"
            aria-pressed={selected}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
            }}
            className="min-w-0 flex-1 cursor-pointer truncate rounded text-left text-sm font-bold"
          >
            {clip.title || "Untitled clip"}
          </button>
          {clip.status === "kept" ? <Badge tone="good">Kept</Badge> : null}
        </div>
        {clip.hook ? <p className="line-clamp-2 text-sm italic text-fg/90">&ldquo;{clip.hook}&rdquo;</p> : null}
        <p className="text-xs tabular-nums text-muted">
          {formatDuration(clip.start_sec)} – {formatDuration(clip.end_sec)} · {Math.round(len)} s
        </p>
        <Breakdown clip={clip} />
        {clip.reason ? <p className="line-clamp-3 text-xs text-muted">{clip.reason}</p> : null}
        <div className="mt-1 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {discarded ? (
            <Button size="sm" variant="secondary" onClick={() => onStatus("candidate")}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Restore
            </Button>
          ) : (
            <>
              <Button size="sm" variant={clip.status === "kept" ? "good" : "secondary"} aria-pressed={clip.status === "kept"} onClick={() => onStatus(clip.status === "kept" ? "candidate" : "kept")}>
                <Check className="h-3.5 w-3.5" aria-hidden /> {clip.status === "kept" ? "Kept" : "Keep"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onStatus("discarded")}>
                <X className="h-3.5 w-3.5" aria-hidden /> Discard
              </Button>
            </>
          )}
          <Link
            href={`/clips/${clip.id}`}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-semibold hover:bg-panel-2"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
          </Link>
        </div>
      </div>
    </article>
  );
}
