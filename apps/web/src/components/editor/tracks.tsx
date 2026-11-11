"use client";

import { captionWordsOnTimeline, pieceDuration, pieceOffsets, totalDuration, type TimedCaptionWord } from "@klipz/shared";
import { memo, useMemo } from "react";
import { cn } from "@/lib/utils";
import * as ops from "@/lib/editor/ops";
import { sliceByStart } from "@/lib/editor/timeline-math";
import { startDrag } from "./drag";
import { useEdit, useEditor, useEditorCtx, useView } from "./editor-context";

export const ROW_H = { video: 46, captions: 28, broll: 32, audio: 32, text: 28 } as const;

const basename = (s: string): string => decodeURIComponent(s.split("/").pop() ?? s);

// ── video ───────────────────────────────────────────────────────────────
export function VideoRow() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const pps = useView((v) => v.pps);
  const selection = useEditor((s) => s.selection);
  const offsets = useMemo(() => pieceOffsets(edit.video), [edit.video]);
  const bounds = ops.trimBounds({ start_sec: ctx.clip.startSec, end_sec: ctx.clip.endSec }, ctx.source.duration);
  const store = ctx.store.getState();

  return (
    <div className="relative" style={{ height: ROW_H.video }} data-track="video">
      {edit.video.map((p, i) => {
        const left = offsets[i]! * pps;
        const width = Math.max(2, pieceDuration(p) * pps);
        const selected = selection?.kind === "piece" && selection.id === p.id;
        const trim = (edge: "start" | "end") => (e: React.PointerEvent) => {
          const cur = ctx.store.getState().edit.video.find((x) => x.id === p.id);
          if (!cur) return;
          const orig = edge === "start" ? cur.srcStart : cur.srcEnd;
          ctx.store.getState().select({ kind: "piece", id: p.id });
          startDrag(e, (dx) => ctx.store.getState().trimPiece(p.id, edge, orig + dx / pps, bounds));
        };
        return (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            aria-label={`Video piece ${i + 1}, ${pieceDuration(p).toFixed(1)} seconds`}
            aria-pressed={selected}
            data-piece-id={p.id}
            onPointerDown={(e) => {
              e.stopPropagation();
              store.select({ kind: "piece", id: p.id });
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              ctx.seekSec(offsets[i]! + (e.clientX - rect.left) / pps);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") store.select({ kind: "piece", id: p.id });
            }}
            className={cn(
              "absolute top-1 bottom-1 cursor-pointer overflow-hidden rounded-md border text-[10px] leading-tight",
              selected ? "border-accent-2 bg-accent/50 ring-1 ring-accent-2" : "border-accent/50 bg-accent/25 hover:bg-accent/35",
            )}
            style={{ left, width }}
          >
            <span className="pointer-events-none block truncate px-2 pt-1 font-semibold">
              {i + 1} · {pieceDuration(p).toFixed(1)}s
            </span>
            {p.transitionIn && p.transitionIn.type !== "none" ? (
              <span className="pointer-events-none absolute bottom-0.5 left-2 rounded bg-black/50 px-1 text-[9px] uppercase">{p.transitionIn.type}</span>
            ) : null}
            <span
              role="separator"
              aria-label="Trim start"
              aria-orientation="vertical"
              onPointerDown={trim("start")}
              className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/20 hover:bg-white/50"
            />
            <span
              role="separator"
              aria-label="Trim end"
              aria-orientation="vertical"
              onPointerDown={trim("end")}
              className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/20 hover:bg-white/50"
            />
          </div>
        );
      })}
      {edit.zooms.map((z) => {
        const selected = selection?.kind === "zoom" && selection.id === z.id;
        return (
          <button
            key={z.id}
            type="button"
            aria-label={`Zoom keyframe at ${z.t.toFixed(2)} seconds, scale ${z.scale.toFixed(2)}`}
            data-zoom-id={z.id}
            onPointerDown={(e) => {
              store.select({ kind: "zoom", id: z.id });
              const orig = z.t;
              startDrag(e, (dx) => ctx.store.getState().apply(ops.updateZoomKey(z.id, { t: orig + dx / pps }), `zoom-move:${z.id}`));
            }}
            className={cn(
              "absolute bottom-0 z-10 h-3.5 w-3.5 -translate-x-1/2 rotate-45 cursor-grab border",
              selected ? "border-white bg-warn" : "border-warn/60 bg-warn/70 hover:bg-warn",
            )}
            style={{ left: z.t * pps }}
          />
        );
      })}
    </div>
  );
}

// ── captions ────────────────────────────────────────────────────────────
type Chip = TimedCaptionWord & { start: number; end: number };

export const CaptionsRow = memo(function CaptionsRow() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const pps = useView((v) => v.pps);
  const scrollLeft = useView((v) => v.scrollLeft);
  const vw = useView((v) => v.viewportWidth);
  const selection = useEditor((s) => s.selection);
  const chips = useMemo<Chip[]>(
    () => captionWordsOnTimeline(edit.video, edit.captions.words).map((w) => ({ ...w, start: w.os, end: w.oe })),
    [edit.video, edit.captions.words],
  );
  const from = scrollLeft / pps - 0.5;
  const to = (scrollLeft + vw) / pps + 0.5;
  const visible = sliceByStart(chips, from, to, 3);
  return (
    <div className={cn("relative", !edit.captions.enabled && "opacity-40")} style={{ height: ROW_H.captions }} data-track="captions" data-visible-chips={visible.length} data-total-chips={chips.length}>
      {visible.map((w) => {
        const selected = selection?.kind === "word" && selection.id === w.id;
        return (
          <button
            key={`${w.id}`}
            type="button"
            data-word-id={w.id}
            onPointerDown={(e) => {
              e.stopPropagation();
              ctx.store.getState().select({ kind: "word", id: w.id });
              ctx.seekSec(w.os);
            }}
            className={cn(
              "absolute top-1 bottom-1 cursor-pointer overflow-hidden whitespace-nowrap rounded border px-1 text-left text-[10px] font-semibold leading-none",
              selected ? "border-white bg-accent text-white" : w.emph ? "border-good/60 bg-good/20 text-good" : "border-line bg-panel-2 text-fg/90 hover:bg-line",
            )}
            style={{ left: w.os * pps, width: Math.max(10, (w.oe - w.os) * pps - 1) }}
            title={`${w.w} (${w.os.toFixed(2)}s)`}
          >
            {w.emoji ? `${w.emoji} ` : ""}
            {w.w}
          </button>
        );
      })}
    </div>
  );
});

// ── b-roll / audio / text ───────────────────────────────────────────────
interface RowItem {
  id: string;
  start: number;
  duration: number;
  label: string;
}

function ItemsRow({
  kind,
  height,
  items,
  tone,
  onChange,
}: {
  kind: "broll" | "audio" | "text";
  height: number;
  items: RowItem[];
  tone: string;
  onChange: (id: string, patch: { start?: number; duration?: number }, key: string) => void;
}) {
  const ctx = useEditorCtx();
  const pps = useView((v) => v.pps);
  const selection = useEditor((s) => s.selection);
  const total = useEditor((s) => totalDuration(s.edit.video));
  return (
    <div className="relative" style={{ height }} data-track={kind}>
      {items.map((it) => {
        const selected = selection?.kind === kind && selection.id === it.id;
        return (
          <div
            key={it.id}
            role="button"
            tabIndex={0}
            aria-label={`${kind} item ${it.label}`}
            aria-pressed={selected}
            data-item-id={it.id}
            onPointerDown={(e) => {
              ctx.store.getState().select({ kind, id: it.id } as never);
              const orig = it.start;
              startDrag(e, (dx) => onChange(it.id, { start: Math.min(Math.max(0, orig + dx / pps), Math.max(0, total - it.duration)) }, `${kind}-move:${it.id}`));
            }}
            className={cn(
              "absolute top-1 bottom-1 cursor-grab overflow-hidden rounded-md border px-2 text-[10px] font-semibold leading-none",
              tone,
              selected && "ring-2 ring-white/80",
            )}
            style={{ left: it.start * pps, width: Math.max(8, it.duration * pps) }}
          >
            <span className="pointer-events-none block truncate pt-2">{it.label}</span>
            <span
              role="separator"
              aria-label="Resize"
              aria-orientation="vertical"
              onPointerDown={(e) => {
                ctx.store.getState().select({ kind, id: it.id } as never);
                const orig = it.duration;
                startDrag(e, (dx) => onChange(it.id, { duration: Math.min(Math.max(ops.MIN_ITEM_SEC, orig + dx / pps), Math.max(ops.MIN_ITEM_SEC, total - it.start)) }, `${kind}-resize:${it.id}`));
              }}
              className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/25 hover:bg-white/60"
            />
          </div>
        );
      })}
    </div>
  );
}

export function BrollRow() {
  const ctx = useEditorCtx();
  const broll = useEdit().broll;
  const items = useMemo(() => broll.map((b) => ({ id: b.id, start: b.start, duration: b.duration, label: `${b.fit === "pip" ? "PiP" : "B-roll"} · ${basename(b.src)}` })), [broll]);
  return (
    <ItemsRow
      kind="broll"
      height={ROW_H.broll}
      items={items}
      tone="border-sky-400/60 bg-sky-500/30"
      onChange={(id, patch, key) => ctx.store.getState().apply(ops.updateBroll(id, patch), key)}
    />
  );
}

export function AudioRow() {
  const ctx = useEditorCtx();
  const audio = useEdit().audio;
  const items = useMemo(() => audio.map((a) => ({ id: a.id, start: a.start, duration: a.duration, label: `${a.kind} · ${basename(a.src)}` })), [audio]);
  return (
    <ItemsRow
      kind="audio"
      height={ROW_H.audio}
      items={items}
      tone="border-emerald-400/60 bg-emerald-500/30"
      onChange={(id, patch, key) => ctx.store.getState().apply(ops.updateAudio(id, patch), key)}
    />
  );
}

export function TextRow() {
  const ctx = useEditorCtx();
  const texts = useEdit().texts;
  const items = useMemo(() => texts.map((t) => ({ id: t.id, start: t.start, duration: t.duration, label: t.text || "(empty)" })), [texts]);
  return (
    <ItemsRow
      kind="text"
      height={ROW_H.text}
      items={items}
      tone="border-pink-400/60 bg-pink-500/30"
      onChange={(id, patch, key) => ctx.store.getState().apply(ops.updateText(id, patch), key)}
    />
  );
}
