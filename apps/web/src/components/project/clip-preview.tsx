"use client";

import { layoutAt, paneVideoStyle, type Clip, type FrameLayout, type SourceVideo, type Word } from "@klipz/shared";
import { Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fileUrl, formatTimecode } from "@/lib/utils";

const OUT_W = 1080;
const OUT_H = 1920;

/**
 * 9:16 preview of a clip: the (hidden-overflow) source <video> confined to
 * [start, end] and positioned with the shared layout maths, so what you see is
 * what the renderer will frame. No crop track yet means a centre crop.
 */
export function ClipPreview({ clip, source, words }: { clip: Clip; source: SourceVideo | null; words: Word[] }) {
  const src = source?.status === "ready" ? fileUrl(source.storage_key) : null;
  const srcW = clip.crop_track?.srcW ?? source?.width ?? 1920;
  const srcH = clip.crop_track?.srcH ?? source?.height ?? 1080;
  const vids = useRef<(HTMLVideoElement | null)[]>([]);
  const [time, setTime] = useState(clip.start_sec);
  const [playing, setPlaying] = useState(false);
  const [layout, setLayout] = useState<FrameLayout>(() => layoutAt(clip.crop_track, clip.start_sec, OUT_W, OUT_H, srcW, srcH));
  const live = useRef({ start: clip.start_sec, end: clip.end_sec, track: clip.crop_track, srcW, srcH });
  live.current = { start: clip.start_sec, end: clip.end_sec, track: clip.crop_track, srcW, srcH };
  const layoutKey = useRef("");

  const tick = useCallback(() => {
    const v = vids.current[0];
    if (!v) return;
    const { start, end, track, srcW: w, srcH: h } = live.current;
    let t = v.currentTime;
    if (t >= end - 0.02 || t < start - 0.5) {
      v.currentTime = start;
      t = start;
    }
    setTime(t);
    const next = layoutAt(track, t, OUT_W, OUT_H, w, h);
    const key = JSON.stringify(next);
    if (key !== layoutKey.current) {
      layoutKey.current = key;
      setLayout(next);
    }
    // extra panes (split layout) show the same moment, muted
    for (let i = 1; i < next.panes.length; i++) {
      const o = vids.current[i];
      if (!o) continue;
      if (Math.abs(o.currentTime - t) > 0.15) o.currentTime = t;
      if (v.paused !== o.paused) void (v.paused ? o.pause() : o.play().catch(() => undefined));
    }
  }, []);

  // New clip or new range: jump to the start and re-evaluate.
  useEffect(() => {
    const v = vids.current[0];
    if (v && (v.currentTime < clip.start_sec - 0.05 || v.currentTime >= clip.end_sec)) v.currentTime = clip.start_sec;
    tick();
  }, [clip.id, clip.start_sec, clip.end_sec, clip.crop_track, tick]);

  // Frame-accurate updates while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, tick]);

  function seek(t: number) {
    const tt = Math.min(Math.max(t, clip.start_sec), clip.end_sec - 0.02);
    for (const v of vids.current) if (v) v.currentTime = tt;
    setTime(tt);
  }

  function toggle() {
    const v = vids.current[0];
    if (!v) return;
    if (v.paused) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }

  const inRange = words.filter((w) => w.e > clip.start_sec && w.s < clip.end_sec);
  let cur = -1;
  for (let i = 0; i < inRange.length; i++) if (inRange[i]!.s <= time) cur = i;
  const curRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (playing) curRef.current?.scrollIntoView({ block: "nearest" });
  }, [cur, playing]);

  if (!src) {
    return (
      <div role="status" className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">
        {source?.status === "deleted"
          ? "The source video was cleaned up, so there is nothing to preview."
          : "The source video isn't ready yet."}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-xl border border-line bg-black">
        {layout.panes.map((p, i) => {
          const st = paneVideoStyle(p, srcW, srcH);
          return (
            <div
              key={i}
              className="absolute overflow-hidden"
              style={{ left: `${(p.dst.x / OUT_W) * 100}%`, top: `${(p.dst.y / OUT_H) * 100}%`, width: `${(p.dst.w / OUT_W) * 100}%`, height: `${(p.dst.h / OUT_H) * 100}%` }}
            >
              <video
                ref={(el) => {
                  vids.current[i] = el;
                }}
                src={src}
                muted={i > 0}
                playsInline
                preload="auto"
                aria-label={i === 0 ? `Preview of ${clip.title ?? "clip"}` : undefined}
                aria-hidden={i > 0 ? true : undefined}
                className="absolute"
                style={{
                  maxWidth: "none",
                  left: `${(st.left / p.dst.w) * 100}%`,
                  top: `${(st.top / p.dst.h) * 100}%`,
                  width: `${(st.width / p.dst.w) * 100}%`,
                  height: `${(st.height / p.dst.h) * 100}%`,
                }}
                onLoadedMetadata={(e) => {
                  e.currentTarget.currentTime = Math.max(live.current.start, e.currentTarget.currentTime >= live.current.end ? 0 : e.currentTarget.currentTime);
                  tick();
                }}
                onPlay={i === 0 ? () => setPlaying(true) : undefined}
                onPause={i === 0 ? () => setPlaying(false) : undefined}
                onSeeked={i === 0 ? tick : undefined}
                onTimeUpdate={i === 0 ? tick : undefined}
              />
            </div>
          );
        })}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/6 bg-gradient-to-t from-black/50 to-transparent" aria-hidden />
      </div>

      <div className="flex w-full max-w-[280px] items-center gap-2">
        <Button size="icon" variant="secondary" onClick={toggle} aria-label={playing ? "Pause preview" : "Play preview"}>
          {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
        </Button>
        <input
          type="range"
          aria-label="Scrub within clip"
          className="min-w-0 flex-1"
          min={clip.start_sec}
          max={clip.end_sec}
          step={0.01}
          value={Math.min(Math.max(time, clip.start_sec), clip.end_sec)}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted">{formatTimecode(Math.max(0, time - clip.start_sec))}</span>
      </div>
      {!clip.crop_track ? <p className="text-xs text-muted">Centre crop. Smart framing is applied once the clip is reframed.</p> : null}

      <div className="max-h-36 w-full overflow-y-auto rounded-lg border border-line bg-panel-2/50 p-2 text-sm leading-relaxed" aria-label="Transcript of the clip">
        {inRange.length === 0 ? (
          <p className="text-xs text-muted">No transcript for this range.</p>
        ) : (
          inRange.map((w, i) => (
            <button
              key={`${w.s}-${i}`}
              ref={i === cur ? curRef : undefined}
              type="button"
              onClick={() => seek(w.s)}
              aria-current={i === cur ? "true" : undefined}
              className={`mr-1 inline cursor-pointer rounded px-0.5 ${i === cur ? "bg-accent text-white" : "hover:bg-line"}`}
            >
              {w.w}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
