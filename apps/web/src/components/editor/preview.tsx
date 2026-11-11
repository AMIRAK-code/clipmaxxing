"use client";

import { OUT_FPS, OUT_H, OUT_W, type EditState } from "@klipz/shared";
import { ClipComposition, clipDurationInFrames, type ClipProps } from "@klipz/video";
import { Player } from "@remotion/player";
import { Frame } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditor, useEditorCtx, useView } from "./editor-context";

/** Player + draggable text handle. Re-renders only when the edit changes, never per frame. */
export function Preview() {
  const ctx = useEditorCtx();
  const edit = useEditor((s) => s.edit);
  const loop = useView((v) => v.loop);
  const showSafeZone = useView((v) => v.showSafeZone);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const h = Math.max(0, Math.floor(Math.min(r.height, r.width * (OUT_H / OUT_W))));
      setSize((prev) => (prev.h === h ? prev : { w: Math.floor((h * OUT_W) / OUT_H), h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const inputProps = useMemo<ClipProps>(
    () => ({
      sourceUrl: ctx.source.url,
      srcW: ctx.source.width,
      srcH: ctx.source.height,
      edit,
      cropTrack: ctx.cropTrack,
      customStyles: [],
      assetBaseUrl: "/api/files/",
      showSafeZone,
    }),
    [ctx.source.url, ctx.source.width, ctx.source.height, ctx.cropTrack, edit, showSafeZone],
  );
  const frames = useMemo(() => clipDurationInFrames(edit, OUT_FPS), [edit]);

  return (
    <section className="relative flex min-w-0 flex-1 flex-col items-center justify-center bg-black/30 p-3" aria-label="Preview">
      <div ref={boxRef} className="flex min-h-0 w-full flex-1 items-center justify-center">
        {size.h > 0 ? (
          <div className="relative shrink-0 overflow-hidden rounded-md bg-black shadow-2xl ring-1 ring-line" style={{ width: size.w, height: size.h }} data-testid="player-box">
            <PlayerView inputProps={inputProps} frames={frames} loop={loop} />
            <TextHandle boxW={size.w} boxH={size.h} />
          </div>
        ) : null}
      </div>
      <div className="absolute right-3 top-3">
        <Button
          size="sm"
          variant={showSafeZone ? "default" : "secondary"}
          aria-pressed={showSafeZone}
          onClick={() => ctx.view.setState({ showSafeZone: !showSafeZone })}
          title="Show platform UI safe zones (preview only)"
        >
          <Frame className="h-3.5 w-3.5" aria-hidden /> Safe zone
        </Button>
      </div>
    </section>
  );
}

const PlayerView = memo(function PlayerView({ inputProps, frames, loop }: { inputProps: ClipProps; frames: number; loop: boolean }) {
  const ctx = useEditorCtx();
  const ref = ctx.playerRef;
  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => ctx.playhead.set(e.detail.frame);
    const onPlay = () => ctx.view.setState({ playing: true });
    const onPause = () => ctx.view.setState({ playing: false });
    p.addEventListener("frameupdate", onFrame);
    p.addEventListener("play", onPlay);
    p.addEventListener("pause", onPause);
    p.addEventListener("ended", onPause);
    ctx.playhead.set(p.getCurrentFrame());
    return () => {
      p.removeEventListener("frameupdate", onFrame);
      p.removeEventListener("play", onPlay);
      p.removeEventListener("pause", onPause);
      p.removeEventListener("ended", onPause);
    };
  }, [ref, ctx.playhead, ctx.view]);
  return (
    <Player
      ref={ref}
      component={ClipComposition}
      inputProps={inputProps}
      durationInFrames={frames}
      compositionWidth={OUT_W}
      compositionHeight={OUT_H}
      fps={OUT_FPS}
      loop={loop}
      controls={false}
      clickToPlay
      doubleClickToFullscreen={false}
      spaceKeyToPlayOrPause={false}
      acknowledgeRemotionLicense
      style={{ width: "100%", height: "100%" }}
    />
  );
});

/** Drag the selected text item on the preview (normalised x/y); double-click to edit its text inline. */
function TextHandle({ boxW, boxH }: { boxW: number; boxH: number }) {
  const ctx = useEditorCtx();
  const selection = useEditor((s) => s.selection);
  const item = useEditor((s) => (s.selection?.kind === "text" ? s.edit.texts.find((t) => t.id === s.selection!.id) : undefined));
  const [editing, setEditing] = useState(false);
  const drag = useRef<{ x: number; y: number; ix: number; iy: number } | null>(null);
  useEffect(() => setEditing(false), [selection]);
  if (!item) return null;
  const scale = boxW / OUT_W;
  const w = Math.max(60, Math.min(boxW - 8, item.text.length * item.fontSize * 0.62 * scale + 24));
  const h = Math.max(28, item.fontSize * 1.3 * scale);
  const update = (patch: Partial<EditState["texts"][number]>) =>
    ctx.store.getState().apply((d) => {
      const t = d.texts.find((x) => x.id === item.id);
      if (t) Object.assign(t, patch);
    }, `text:${item.id}:${Object.keys(patch).join(",")}`);

  return (
    <div
      role="group"
      aria-label="Text position handle"
      data-testid="text-handle"
      className={cn("absolute z-10 cursor-move touch-none rounded border-2 border-dashed border-accent-2 bg-accent/10", editing && "cursor-text")}
      style={{ left: item.x * boxW, top: item.y * boxH, width: w, height: h, transform: "translate(-50%, -50%)" }}
      onPointerDown={(e) => {
        if (editing) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, ix: item.x, iy: item.y };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        update({
          x: Math.min(1, Math.max(0, d.ix + (e.clientX - d.x) / boxW)),
          y: Math.min(1, Math.max(0, d.iy + (e.clientY - d.y) / boxH)),
        });
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => setEditing(true)}
    >
      {editing ? (
        <input
          autoFocus
          aria-label="Text"
          value={item.text}
          onChange={(e) => update({ text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setEditing(false);
          }}
          className="h-full w-full bg-black/60 px-1 text-center text-xs text-white outline-none"
        />
      ) : null}
    </div>
  );
}
