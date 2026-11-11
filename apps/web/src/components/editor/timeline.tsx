"use client";

import { OUT_FPS, totalDuration } from "@klipz/shared";
import { Diamond, Maximize2, Pause, Play, Redo2, Repeat, Scissors, SkipBack, SkipForward, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { clampPps, fitPps, rulerTicks, scrollAfterZoom } from "@/lib/editor/timeline-math";
import { cn, formatTimecode } from "@/lib/utils";
import { startDrag } from "./drag";
import { useEdit, useEditor, useEditorCtx, useView } from "./editor-context";
import { AudioRow, BrollRow, CaptionsRow, ROW_H, TextRow, VideoRow } from "./tracks";
import { TIMELINE_ZOOM_EVENT } from "./use-shortcuts";

const LABEL_W = 84;
const RULER_H = 24;
const TAIL_PX = 160; // room after the last frame so the end handle is reachable

const TRACKS: Array<{ key: keyof typeof ROW_H; label: string }> = [
  { key: "video", label: "Video" },
  { key: "captions", label: "Captions" },
  { key: "broll", label: "B-roll" },
  { key: "audio", label: "Audio" },
  { key: "text", label: "Text" },
];

export function Timeline() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const pps = useView((v) => v.pps);
  const total = totalDuration(edit.video);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const fitted = useRef(false);

  // viewport size + scroll position → view store (rAF throttled)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const sync = () => {
      raf = 0;
      ctx.view.setState({ scrollLeft: el.scrollLeft, viewportWidth: el.clientWidth });
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(sync);
    };
    sync();
    el.addEventListener("scroll", queue, { passive: true });
    const ro = new ResizeObserver(() => {
      queue();
      if (!fitted.current && el.clientWidth > 0) {
        fitted.current = true;
        ctx.view.setState({ pps: fitPps(totalDuration(ctx.store.getState().edit.video), el.clientWidth - 48) });
      }
    });
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", queue);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ctx]);

  const zoomBy = useCallback(
    (factor: number, anchorX?: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const old = ctx.view.getState().pps;
      const next = clampPps(old * factor);
      if (next === old) return;
      const anchor = anchorX ?? Math.min(el.clientWidth - 20, Math.max(20, (ctx.playhead.current / OUT_FPS) * old - el.scrollLeft));
      pendingScroll.current = scrollAfterZoom(el.scrollLeft, anchor, old, next);
      ctx.view.setState({ pps: next });
    },
    [ctx],
  );
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
  }, [pps]);

  // Ctrl+wheel zoom (native listener: React's wheel handlers are passive)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - el.getBoundingClientRect().left);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // native horizontal scroll
      } else if (el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const onZoom = (e: Event) => zoomBy((e as CustomEvent<{ factor: number }>).detail.factor);
    window.addEventListener(TIMELINE_ZOOM_EVENT, onZoom);
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener(TIMELINE_ZOOM_EVENT, onZoom);
    };
  }, [zoomBy]);

  // Playhead: direct DOM transform, no React state per frame.
  useEffect(() => {
    return ctx.playhead.subscribe((frame) => {
      const head = headRef.current;
      const sc = scrollRef.current;
      if (!head) return;
      const x = (frame / OUT_FPS) * pps;
      head.style.transform = `translate3d(${x}px,0,0)`;
      if (sc && ctx.playerRef.current?.isPlaying()) {
        if (x > sc.scrollLeft + sc.clientWidth - 24 || x < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - 48);
      }
    });
  }, [ctx, pps]);

  // keep the playhead inside a shortened clip
  const frames = Math.max(1, Math.round(total * OUT_FPS));
  useEffect(() => {
    if (ctx.playhead.current > frames - 1) ctx.seekFrame(frames - 1);
  }, [frames, ctx]);

  const timeFromEvent = useCallback(
    (clientX: number) => {
      const rect = contentRef.current!.getBoundingClientRect();
      return Math.min(Math.max(0, (clientX - rect.left - LABEL_W * 0) / ctx.view.getState().pps), totalDuration(ctx.store.getState().edit.video));
    },
    [ctx],
  );
  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    ctx.store.getState().select(null);
    ctx.seekSec(timeFromEvent(e.clientX));
    startDrag(e, (_dx, _dy, ev) => ctx.seekSec(timeFromEvent(ev.clientX)));
  };

  const contentW = Math.max(total * pps + TAIL_PX, 200);
  const bodyH = RULER_H + TRACKS.reduce((n, t) => n + ROW_H[t.key], 0);

  return (
    <section className="flex shrink-0 flex-col border-t border-line bg-panel" style={{ height: 40 + bodyH + 10 }} aria-label="Timeline">
      <Toolbar zoomBy={zoomBy} fit={() => scrollRef.current && ctx.view.setState({ pps: fitPps(total, scrollRef.current.clientWidth - 48) })} />
      <div className="flex min-h-0 flex-1">
        <div className="shrink-0 border-r border-line bg-panel" style={{ width: LABEL_W, paddingTop: RULER_H }}>
          {TRACKS.map((t) => (
            <div key={t.key} className="flex items-center px-2 text-[10px] font-semibold uppercase tracking-wide text-muted" style={{ height: ROW_H[t.key] }}>
              {t.label}
            </div>
          ))}
        </div>
        <div ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden" data-testid="timeline-scroll">
          <div ref={contentRef} className="relative" style={{ width: contentW, height: bodyH }} onPointerDown={scrub} data-testid="timeline-content">
            <Ruler total={total} />
            <div style={{ paddingTop: RULER_H }}>
              {TRACKS.map((t, i) => (
                <div key={t.key} className={cn("border-t border-line/60", i % 2 === 1 && "bg-white/[0.02]")}>
                  {t.key === "video" ? <VideoRow /> : t.key === "captions" ? <CaptionsRow /> : t.key === "broll" ? <BrollRow /> : t.key === "audio" ? <AudioRow /> : <TextRow />}
                </div>
              ))}
            </div>
            <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-0" ref={headRef} data-testid="playhead" style={{ transform: "translate3d(0,0,0)", willChange: "transform" }}>
              <div className="absolute -left-[6px] top-0 h-3 w-3 rotate-45 rounded-sm bg-accent-2" />
              <div className="absolute -left-px inset-y-0 w-0.5 bg-accent-2" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const Ruler = memo(function Ruler({ total }: { total: number }) {
  const pps = useView((v) => v.pps);
  const scrollLeft = useView((v) => v.scrollLeft);
  const vw = useView((v) => v.viewportWidth);
  const ticks = rulerTicks(pps, scrollLeft / pps - 1, (scrollLeft + vw) / pps + 1);
  return (
    <div className="absolute inset-x-0 top-0 cursor-pointer border-b border-line bg-panel-2/60" style={{ height: RULER_H }} aria-hidden data-total={total}>
      {ticks.map((t) => (
        <div key={t.t} className="absolute top-0" style={{ left: t.x }}>
          <div className={cn("w-px bg-line", t.major ? "h-3.5" : "h-2")} style={{ marginTop: t.major ? 10 : 14 }} />
          {t.label ? <span className="absolute left-1 top-0 text-[9px] tabular-nums text-muted">{t.label}</span> : null}
        </div>
      ))}
    </div>
  );
});

function Toolbar({ zoomBy, fit }: { zoomBy: (f: number) => void; fit: () => void }) {
  const ctx = useEditorCtx();
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const selection = useEditor((s) => s.selection);
  const playing = useView((v) => v.playing);
  const loop = useView((v) => v.loop);
  const total = useEditor((s) => totalDuration(s.edit.video));
  const timeRef = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      ctx.playhead.subscribe((frame) => {
        if (timeRef.current) timeRef.current.textContent = formatTimecode(frame / OUT_FPS);
      }),
    [ctx.playhead],
  );
  const st = ctx.store.getState();
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
      <Button size="iconSm" variant="ghost" onClick={st.undo} disabled={!canUndo} aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)">
        <Undo2 className="h-4 w-4" aria-hidden />
      </Button>
      <Button size="iconSm" variant="ghost" onClick={st.redo} disabled={!canRedo} aria-label="Redo (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)">
        <Redo2 className="h-4 w-4" aria-hidden />
      </Button>
      <span className="mx-1 h-5 w-px bg-line" />
      <Button size="iconSm" variant="ghost" onClick={() => ctx.seekFrame(ctx.playhead.current - 1)} aria-label="Previous frame (←)" title="Previous frame (←)">
        <SkipBack className="h-4 w-4" aria-hidden />
      </Button>
      <Button size="iconSm" variant="secondary" onClick={ctx.togglePlay} aria-label={playing ? "Pause (Space)" : "Play (Space)"} title={playing ? "Pause (Space)" : "Play (Space)"} data-testid="play-toggle">
        {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
      </Button>
      <Button size="iconSm" variant="ghost" onClick={() => ctx.seekFrame(ctx.playhead.current + 1)} aria-label="Next frame (→)" title="Next frame (→)">
        <SkipForward className="h-4 w-4" aria-hidden />
      </Button>
      <span className="ml-1 min-w-[8.5rem] text-xs tabular-nums text-muted" aria-label="Playhead time">
        <span ref={timeRef} data-testid="time-current" className="text-fg">
          0:00.00
        </span>{" "}
        / <span data-testid="time-total">{formatTimecode(total)}</span>
      </span>
      <Button size="iconSm" variant={loop ? "secondary" : "ghost"} aria-pressed={loop} onClick={() => ctx.view.setState({ loop: !loop })} aria-label="Loop" title="Loop">
        <Repeat className="h-4 w-4" aria-hidden />
      </Button>
      <span className="mx-1 h-5 w-px bg-line" />
      <Button size="sm" variant="secondary" onClick={() => st.splitAt(ctx.getTime())} aria-label="Split at playhead (S)" title="Split at playhead (S)">
        <Scissors className="h-3.5 w-3.5" aria-hidden /> Split
      </Button>
      <Button size="sm" variant="secondary" onClick={() => st.addZoom(ctx.getTime())} aria-label="Add zoom keyframe at playhead" title="Add zoom keyframe at playhead">
        <Diamond className="h-3.5 w-3.5" aria-hidden /> Zoom key
      </Button>
      <Button
        size="sm"
        variant="danger"
        disabled={!selection || (selection.kind === "piece" && ctx.store.getState().edit.video.length <= 1)}
        onClick={() => st.deleteSelection()}
        aria-label="Delete selection (Delete)"
        title={selection?.kind === "piece" ? "Ripple delete piece (Delete)" : "Delete selection (Delete)"}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden /> {selection?.kind === "piece" ? "Ripple delete" : "Delete"}
      </Button>
      <div className="ml-auto flex items-center gap-1">
        <Button size="iconSm" variant="ghost" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out (-)" title="Zoom out (-)">
          <ZoomOut className="h-4 w-4" aria-hidden />
        </Button>
        <Button size="iconSm" variant="ghost" onClick={() => zoomBy(1.5)} aria-label="Zoom in (+)" title="Zoom in (+)">
          <ZoomIn className="h-4 w-4" aria-hidden />
        </Button>
        <Button size="iconSm" variant="ghost" onClick={fit} aria-label="Fit timeline" title="Fit timeline">
          <Maximize2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
