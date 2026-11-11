"use client";

import { LOOKS, pieceDuration, totalDuration, type LookId, type TransitionType } from "@klipz/shared";
import { Diamond, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import * as ops from "@/lib/editor/ops";
import { cn } from "@/lib/utils";
import { NumberInput, Section, SelectInput, Slider } from "./controls";
import { useEdit, useEditor, useEditorCtx } from "./editor-context";

const TRANSITIONS: TransitionType[] = ["none", "fade", "slide", "zoom", "flash"];

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
          <p className="text-xs text-muted">Select a piece on the Video track. Split with S, then trim its edges or ripple delete it.</p>
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
