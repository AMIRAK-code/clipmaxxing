"use client";

import { ImageIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const THUMBS = 8;
const THUMB_W = 54;
const THUMB_H = 96;

function drawFrame(video: HTMLVideoElement, w: number, h: number): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx || !video.videoWidth) return null;
    // cover-fit the frame into w x h
    const s = Math.max(w / video.videoWidth, h / video.videoHeight);
    const dw = video.videoWidth * s;
    const dh = video.videoHeight * s;
    ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = t;
  });
}

/**
 * Cover frame picker. Scrub the slider (or click a thumbnail) to find a frame,
 * then "Use this frame". The chosen time is reported in milliseconds.
 */
export function CoverPicker({ src, durationSec, valueMs, onChange }: { src: string; durationSec: number; valueMs: number | null; onChange: (ms: number | null) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(valueMs !== null ? valueMs / 1000 : 0);
  const [thumbs, setThumbs] = useState<{ t: number; url: string }[]>([]);
  const [still, setStill] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const dur = Math.max(0.1, durationSec);

  // Thumbnail strip from a separate element so scrubbing is never disturbed.
  useEffect(() => {
    let cancelled = false;
    setThumbs([]);
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    const run = async () => {
      await new Promise<void>((res, rej) => {
        v.addEventListener("loadeddata", () => res(), { once: true });
        v.addEventListener("error", () => rej(new Error("video error")), { once: true });
      });
      const out: { t: number; url: string }[] = [];
      for (let i = 0; i < THUMBS && !cancelled; i++) {
        const at = Math.min(dur - 0.05, (dur * (i + 0.5)) / THUMBS);
        await seek(v, Math.max(0, at));
        const url = drawFrame(v, THUMB_W, THUMB_H);
        if (url) out.push({ t: at, url });
        if (!cancelled) setThumbs([...out]);
      }
    };
    run().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      v.removeAttribute("src");
      v.load();
    };
  }, [src, dur]);

  const goto = useCallback((to: number) => {
    const clamped = Math.min(Math.max(0, to), Math.max(0, dur - 0.05));
    setT(clamped);
    const v = videoRef.current;
    if (v) v.currentTime = clamped;
  }, [dur]);

  // Show the chosen frame as a still once the main element can seek.
  const onMeta = () => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = valueMs !== null ? valueMs / 1000 : 0;
  };
  const onSeeked = () => {
    const v = videoRef.current;
    if (v && valueMs !== null && Math.abs(v.currentTime - valueMs / 1000) < 0.06 && !still) setStill(drawFrame(v, 135, 240));
  };

  const choose = () => {
    const v = videoRef.current;
    const ms = Math.round((v?.currentTime ?? t) * 1000);
    onChange(ms);
    if (v) setStill(drawFrame(v, 135, 240));
  };

  return (
    <div className="flex flex-col gap-3" data-testid="cover-picker">
      <div className="flex gap-4">
        <video
          ref={videoRef}
          src={src}
          muted
          preload="auto"
          playsInline
          aria-label="Cover frame scrubber"
          className="h-56 w-[126px] shrink-0 rounded-md bg-black object-cover"
          onLoadedMetadata={onMeta}
          onSeeked={onSeeked}
          onError={() => setFailed(true)}
          onTimeUpdate={(e) => setT((e.target as HTMLVideoElement).currentTime)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            <span className="flex justify-between">
              <span>Scrub to a frame</span>
              <span className="tabular-nums text-fg" data-testid="cover-time">{t.toFixed(2)} s / {dur.toFixed(1)} s</span>
            </span>
            <input
              type="range"
              min={0}
              max={dur}
              step={0.05}
              value={Math.min(t, dur)}
              onChange={(e) => goto(Number(e.target.value))}
              aria-label="Cover frame position in seconds"
              className="w-full"
            />
          </label>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Frame thumbnails">
            {thumbs.length === 0 && !failed ? <p className="text-xs text-muted">Generating thumbnails…</p> : null}
            {thumbs.map((th) => (
              // eslint-disable-next-line @next/next/no-img-element
              <button key={th.t} type="button" onClick={() => goto(th.t)} aria-label={`Jump to ${th.t.toFixed(1)} seconds`} className={cn("cursor-pointer overflow-hidden rounded border", Math.abs(th.t - t) < dur / THUMBS / 2 ? "border-accent" : "border-line hover:border-accent/50")}>
                <img src={th.url} alt="" width={THUMB_W / 1.5} height={THUMB_H / 1.5} className="block h-16 w-9 object-cover" />
              </button>
            ))}
            {failed ? <p className="text-xs text-warn">Could not decode the video here; the slider still sets the time.</p> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={choose} data-testid="cover-use">
              <ImageIcon className="h-3.5 w-3.5" aria-hidden /> Use this frame as cover
            </Button>
            {valueMs !== null ? (
              <Button size="sm" variant="ghost" onClick={() => (onChange(null), setStill(null))}>
                Reset to automatic
              </Button>
            ) : null}
            <span className="text-xs text-muted" data-testid="cover-status">
              {valueMs !== null ? `Cover set at ${(valueMs / 1000).toFixed(2)} s (${valueMs} ms)` : "Automatic: the platform picks the cover"}
            </span>
          </div>
        </div>
        {valueMs !== null && still ? (
          <div className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={still} alt="Selected cover frame" className="h-56 w-[126px] rounded-md border border-accent object-cover" data-testid="cover-still" />
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted">Instagram and TikTok use this frame as the cover (also aggregator-routed posts where the aggregator supports it). YouTube, Facebook, X and LinkedIn choose their own cover.</p>
    </div>
  );
}
