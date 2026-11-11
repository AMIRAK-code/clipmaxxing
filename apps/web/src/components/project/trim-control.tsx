"use client";

import type { Word } from "@klipz/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtSec } from "@/lib/clip-ui";
import { moveEdge, nudgeStep, snapToBoundary, wordBoundaries } from "@/lib/trim";

const PAD = 15;
const COMMIT_DELAY_MS = 600;

type Edge = "start" | "end";

/**
 * Two-handle range control over a mini timeline (±15 s around the clip).
 * Dragging snaps to word boundaries (hold Alt to turn that off); arrow keys
 * nudge 0.1 s, Shift+arrow 1 s. Commits are debounced. Mount with key={clipId}.
 */
export function TrimControl({
  start,
  end,
  duration,
  words,
  onCommit,
}: {
  start: number;
  end: number;
  duration: number | null;
  words: Word[];
  onCommit: (start: number, end: number) => void;
}) {
  const [win] = useState(() => ({ lo: Math.max(0, start - PAD), hi: duration ? Math.min(duration, end + PAD) : end + PAD }));
  const [draft, setDraft] = useState<[number, number]>([start, end]);
  const draftRef = useRef(draft);
  const dragging = useRef<Edge | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const committed = useRef({ start, end });
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  committed.current = { start, end };

  const bounds = useMemo(() => wordBoundaries(words), [words]);
  const span = Math.max(0.001, win.hi - win.lo);
  const pct = (t: number) => `${Math.min(100, Math.max(0, ((t - win.lo) / span) * 100))}%`;

  // Follow outside changes (server response, other edits) unless the user is mid-edit.
  useEffect(() => {
    if (dragging.current || timer.current) return;
    draftRef.current = [start, end];
    setDraft([start, end]);
  }, [start, end]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function apply(edge: Edge, t: number, snap: boolean, alt: boolean) {
    const target = snap ? snapToBoundary(t, bounds, 0.25, alt) : t;
    const [s, e] = moveEdge(draftRef.current[0], draftRef.current[1], edge, target, { duration });
    draftRef.current = [s, e];
    setDraft([s, e]);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const [cs, ce] = draftRef.current;
      if (Math.abs(cs - committed.current.start) > 1e-6 || Math.abs(ce - committed.current.end) > 1e-6) onCommitRef.current(cs, ce);
    }, COMMIT_DELAY_MS);
  }

  const timeAt = (clientX: number): number => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return draftRef.current[0];
    return win.lo + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };

  const handle = (edge: Edge) => {
    const value = edge === "start" ? draft[0] : draft[1];
    return (
      <div
        role="slider"
        tabIndex={0}
        aria-label={edge === "start" ? "Clip start" : "Clip end"}
        aria-orientation="horizontal"
        aria-valuemin={win.lo}
        aria-valuemax={win.hi}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={`${value.toFixed(1)} seconds`}
        className="absolute top-0 z-10 h-full w-3 -translate-x-1/2 cursor-ew-resize touch-none rounded bg-accent shadow focus-visible:outline-2"
        style={{ left: pct(value) }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = edge;
        }}
        onPointerMove={(e) => {
          if (dragging.current === edge) apply(edge, timeAt(e.clientX), true, e.altKey);
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
        onKeyDown={(e) => {
          const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          apply(edge, value + dir * nudgeStep(e.shiftKey), false, true);
        }}
      >
        <span className="absolute left-1/2 top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded bg-white/80" />
      </div>
    );
  };

  const len = draft[1] - draft[0];
  const changed = Math.abs(len - (end - start)) > 1e-3 || Math.abs(draft[0] - start) > 1e-3;
  const visibleBounds = bounds.filter((b) => b >= win.lo && b <= win.hi);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-semibold">Trim</span>
        <span className="tabular-nums text-muted" aria-live="polite">
          Length <span className="font-semibold text-fg">{fmtSec(len)}</span>
          {changed ? ` (was ${fmtSec(end - start)})` : ""}
        </span>
      </div>
      <div ref={track} className="relative h-9 rounded-md bg-panel-2" onPointerDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const t = timeAt(e.clientX);
        apply(Math.abs(t - draftRef.current[0]) < Math.abs(t - draftRef.current[1]) ? "start" : "end", t, true, e.altKey);
      }}>
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden>
          {visibleBounds.map((b) => {
            const x = ((b - win.lo) / span) * 1000;
            return <line key={b} x1={x} x2={x} y1={3} y2={7} stroke="currentColor" className="text-muted/50" strokeWidth={1} vectorEffect="non-scaling-stroke" />;
          })}
        </svg>
        <div className="pointer-events-none absolute top-0 h-full rounded bg-accent/25" style={{ left: pct(draft[0]), width: `${(len / span) * 100}%` }} />
        {handle("start")}
        {handle("end")}
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-muted">
        <span>{win.lo.toFixed(1)} s</span>
        <span>Arrow keys nudge 0.1 s, Shift 1 s. Hold Alt to skip snapping.</span>
        <span>{win.hi.toFixed(1)} s</span>
      </div>
    </div>
  );
}
