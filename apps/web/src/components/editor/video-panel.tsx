"use client";

import { LOOKS, MAX_FRAME_ZOOM, pieceDuration, pieceVolume, totalDuration, type LookId, type TransitionType } from "@klipz/shared";
import { Diamond, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as ops from "@/lib/editor/ops";
import { cn } from "@/lib/utils";
import { NumberInput, Section, SelectInput, Slider } from "./controls";
import { useEdit, useEditor, useEditorCtx } from "./editor-context";

const TRANSITIONS: TransitionType[] = ["none", "fade", "slide", "zoom", "flash"];
type FrameMode = "auto" | "crop" | "letterbox";
type PieceFrameMode = "clip" | "crop" | "letterbox";
type PieceLook = LookId | "clip";

export function VideoPanel() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const selection = useEditor((s) => s.selection);
  const st = ctx.store.getState();
  const total = totalDuration(edit.video);
  const pieceIdx = selection?.kind === "piece" ? edit.video.findIndex((p) => p.id === selection.id) : -1;
  const piece = pieceIdx >= 0 ? edit.video[pieceIdx] : undefined;
  const zoom = selection?.kind === "zoom" ? edit.zooms.find((z) => z.id === selection.id) : undefined;

  return (
    <div>
      <Section title="Framing">
        <SelectInput<FrameMode>
          label="Crop"
          value={edit.frame ? edit.frame.layout : "auto"}
          options={[
            { value: "auto", label: "Automatic (the framing KLIPZ chose)" },
            { value: "crop", label: "Manual: crop, zoom and position" },
            { value: "letterbox", label: "Manual: whole picture, blurred bars" },
          ]}
          onChange={(v) => st.apply(v === "auto" ? ops.setFrame(null) : ops.patchFrame({ layout: v }))}
        />
        {edit.frame?.layout === "crop" ? (
          <>
            <Slider label="Zoom" value={edit.frame.zoom} min={1} max={MAX_FRAME_ZOOM} step={0.05} onChange={(v) => st.apply(ops.patchFrame({ zoom: v }), "frame-zoom")} format={(v) => `${v.toFixed(2)}×`} testId="frame-zoom" />
            <Slider label="Left / right" value={edit.frame.cx} min={0} max={1} step={0.005} onChange={(v) => st.apply(ops.patchFrame({ cx: v }), "frame-cx")} format={(v) => `${Math.round(v * 100)}%`} testId="frame-cx" />
            <Slider label="Up / down" value={edit.frame.cy} min={0} max={1} step={0.005} onChange={(v) => st.apply(ops.patchFrame({ cy: v }), "frame-cy")} format={(v) => `${Math.round(v * 100)}%`} testId="frame-cy" />
            <Button size="sm" variant="secondary" onClick={() => st.apply(ops.patchFrame({ cx: 0.5, cy: 0.5, zoom: 1 }))}>
              Centre and reset zoom
            </Button>
          </>
        ) : null}
        <p className="text-xs text-muted">
          {edit.frame
            ? "This crop is used for the whole clip instead of the automatic framing. Left / right and up / down move the window inside the picture; at zoom 1 a wide video can only move sideways."
            : "Automatic uses the framing chosen when the clip was made (speaker tracking, centre or fit). Switch to manual to crop, zoom and position the video yourself."}{" "}
          To crop one part differently, split the video (S), select the piece and set its own crop under Selected piece.
        </p>
      </Section>

      <Section title="Look">
        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Look">
          {(Object.keys(LOOKS) as LookId[]).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={edit.look === id}
              data-look={id}
              onClick={() => st.apply(ops.setLook(id))}
              className={cn(
                "flex cursor-pointer flex-col items-center gap-1 rounded-lg border p-1 text-[10px] font-semibold",
                edit.look === id ? "border-accent-2 ring-1 ring-accent-2" : "border-line hover:border-accent/60",
              )}
            >
              <span
                className="h-8 w-full rounded bg-gradient-to-br from-orange-400 via-emerald-500 to-sky-600"
                style={{ filter: LOOKS[id].filter }}
                aria-hidden
              />
              {LOOKS[id].name}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Selected piece">
        {piece ? (
          <>
            <p className="text-xs text-muted">
              Piece {pieceIdx + 1} of {edit.video.length} · {pieceDuration(piece).toFixed(2)} s · source {piece.srcStart.toFixed(2)}–{piece.srcEnd.toFixed(2)}
            </p>
            <SelectInput<PieceFrameMode>
              label="Crop"
              value={piece.frame ? piece.frame.layout : "clip"}
              options={[
                { value: "clip", label: "Same as the clip" },
                { value: "crop", label: "Own crop, zoom and position" },
                { value: "letterbox", label: "Own: whole picture, blurred bars" },
              ]}
              onChange={(v) => st.apply(v === "clip" ? ops.setPieceFrame(piece.id, null) : ops.patchPieceFrame(piece.id, { layout: v }))}
            />
            {piece.frame?.layout === "crop" ? (
              <>
                <Slider label="Zoom" value={piece.frame.zoom} min={1} max={MAX_FRAME_ZOOM} step={0.05} onChange={(v) => st.apply(ops.patchPieceFrame(piece.id, { zoom: v }), `pframe-zoom:${piece.id}`)} format={(v) => `${v.toFixed(2)}×`} testId="piece-frame-zoom" />
                <Slider label="Left / right" value={piece.frame.cx} min={0} max={1} step={0.005} onChange={(v) => st.apply(ops.patchPieceFrame(piece.id, { cx: v }), `pframe-cx:${piece.id}`)} format={(v) => `${Math.round(v * 100)}%`} testId="piece-frame-cx" />
                <Slider label="Up / down" value={piece.frame.cy} min={0} max={1} step={0.005} onChange={(v) => st.apply(ops.patchPieceFrame(piece.id, { cy: v }), `pframe-cy:${piece.id}`)} format={(v) => `${Math.round(v * 100)}%`} testId="piece-frame-cy" />
                <Button size="sm" variant="secondary" onClick={() => st.apply(ops.patchPieceFrame(piece.id, { cx: 0.5, cy: 0.5, zoom: 1 }))}>
                  Centre and reset zoom
                </Button>
              </>
            ) : null}
            <SelectInput<PieceLook>
              label="Look"
              value={piece.look ?? "clip"}
              options={[{ value: "clip", label: "Same as the clip" }, ...(Object.keys(LOOKS) as LookId[]).map((id) => ({ value: id as PieceLook, label: LOOKS[id].name }))]}
              onChange={(v) => st.apply(ops.setPieceLook(piece.id, v === "clip" ? null : v))}
            />
            <Slider
              label="Volume"
              value={pieceVolume(edit, piece)}
              min={0}
              max={1.5}
              step={0.05}
              onChange={(v) => st.apply(ops.setPieceVolume(piece.id, v), `pvol:${piece.id}`)}
              format={(v) => `${Math.round(v * 100)}%${piece.volume === undefined ? " (clip)" : ""}`}
              testId="piece-volume"
            />
            {piece.frame || piece.look !== undefined || piece.volume !== undefined ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  st.apply((d) => {
                    const p = d.video.find((x) => x.id === piece.id);
                    if (!p) return;
                    delete p.frame;
                    delete p.look;
                    delete p.volume;
                  })
                }
              >
                Use the clip&apos;s crop, look and volume
              </Button>
            ) : null}
            <SelectInput<TransitionType>
              label="Transition in"
              value={piece.transitionIn?.type ?? "none"}
              options={TRANSITIONS.map((v) => ({ value: v, label: v }))}
              onChange={(v) => st.apply(ops.setTransition(piece.id, v, piece.transitionIn?.durationSec ?? 0.4))}
            />
            {piece.transitionIn && piece.transitionIn.type !== "none" ? (
              <Slider
                label="Duration"
                value={piece.transitionIn.durationSec}
                min={0.1}
                max={1.5}
                step={0.05}
                onChange={(v) => st.apply(ops.setTransition(piece.id, piece.transitionIn!.type, v), `trans:${piece.id}`)}
                format={(v) => `${v.toFixed(2)}s`}
              />
            ) : null}
            <Button size="sm" variant="danger" disabled={edit.video.length <= 1} onClick={() => st.rippleDeletePiece(piece.id)}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Ripple delete piece
            </Button>
          </>
        ) : (
          <p className="text-xs text-muted">
            Select a piece on the Video track. Split with S, then give each piece its own crop, zoom, position, look and volume, trim its edges or ripple delete it.
          </p>
        )}
      </Section>

      <Section
        title={`Zoom keyframes (${edit.zooms.length})`}
        action={
          <Button size="sm" variant="secondary" onClick={() => st.addZoom(ctx.getTime())}>
            <Diamond className="h-3.5 w-3.5" aria-hidden /> Add at playhead
          </Button>
        }
      >
        {edit.zooms.length === 0 ? <p className="text-xs text-muted">Keyframes interpolate the punch-in between them. Add two to animate a push-in.</p> : null}
        <ul className="flex flex-col gap-1">
          {edit.zooms.map((z) => (
            <li key={z.id}>
              <button
                type="button"
                onClick={() => {
                  st.select({ kind: "zoom", id: z.id });
                  ctx.seekSec(z.t);
                }}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between rounded-lg border px-2 py-1.5 text-xs",
                  zoom?.id === z.id ? "border-accent-2 bg-accent/15" : "border-line hover:bg-panel-2",
                )}
              >
                <span className="tabular-nums">{z.t.toFixed(2)} s</span>
                <span className="text-muted">
                  ×{z.scale.toFixed(2)} · {z.ease}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {zoom ? (
          <div className="flex flex-col gap-2.5 rounded-lg border border-line p-2.5">
            <Slider
              label="Scale"
              testId="zoom-scale"
              value={zoom.scale}
              min={1}
              max={3}
              step={0.05}
              onChange={(v) => st.apply(ops.updateZoomKey(zoom.id, { scale: v }), `zoom-scale:${zoom.id}`)}
              format={(v) => `×${v.toFixed(2)}`}
            />
            <NumberInput label="Time (s)" value={zoom.t} min={0} max={total} step={0.05} onChange={(v) => st.apply(ops.updateZoomKey(zoom.id, { t: v }), `zoom-t:${zoom.id}`)} />
            <SelectInput<"linear" | "ease" | "snap">
              label="Ease"
              value={zoom.ease}
              options={[
                { value: "ease", label: "Ease" },
                { value: "linear", label: "Linear" },
                { value: "snap", label: "Snap (hold)" },
              ]}
              onChange={(v) => st.apply(ops.updateZoomKey(zoom.id, { ease: v }))}
            />
            <Button size="sm" variant="danger" onClick={() => st.deleteSelection()}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove keyframe
            </Button>
          </div>
        ) : null}
      </Section>

      <Section title="Main audio">
        <Slider label="Volume" value={edit.volume} min={0} max={1.5} step={0.05} onChange={(v) => st.apply(ops.setVolume(v), "volume")} format={(v) => `${Math.round(v * 100)}%`} />
        <Slider label="Duck level" value={edit.duckLevel} min={0} max={1} step={0.05} onChange={(v) => st.apply(ops.setDuckLevel(v), "duck")} format={(v) => `${Math.round(v * 100)}%`} />
        <p className="text-xs text-muted">Main audio drops to the duck level while b-roll or audio items with &ldquo;duck&rdquo; on are playing.</p>
      </Section>
    </div>
  );
}
