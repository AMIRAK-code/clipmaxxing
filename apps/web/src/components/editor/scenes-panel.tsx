"use client";

import { pieceDuration, pieceOffsets, totalDuration, type MontageScene } from "@klipz/shared";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input, Switch } from "@/components/ui/primitives";
import * as ops from "@/lib/editor/ops";
import { addScene, isMuted, moveScene, sceneOfPiece, setMuted } from "@/lib/montage";
import { cn } from "@/lib/utils";
import { Row, Section } from "./controls";
import { useEdit, useEditor, useEditorCtx } from "./editor-context";

const secs = (s: number) => `${s.toFixed(1)} s`;

/** A montage's own controls: its scenes (order, remove, add from the pool), sound, captions, hook card. */
export function ScenesPanel({ scenes }: { scenes: MontageScene[] }) {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const selection = useEditor((s) => s.selection);
  const st = ctx.store.getState();
  const offsets = pieceOffsets(edit.video);
  const selectedPiece = selection?.kind === "piece" ? selection.id : null;
  const used = useMemo(() => new Set(edit.video.map((p) => sceneOfPiece(scenes, p)?.id).filter(Boolean)), [edit.video, scenes]);
  const byVideo = useMemo(() => {
    const m = new Map<string, MontageScene[]>();
    for (const s of scenes) m.set(s.name, [...(m.get(s.name) ?? []), s]);
    return [...m.entries()];
  }, [scenes]);
  const muted = isMuted(edit);

  return (
    <div data-testid="scenes-panel">
      <Section title={`Scenes · ${secs(totalDuration(edit.video))}`}>
        <ol className="flex flex-col gap-1.5">
          {edit.video.map((p, i) => {
            const scene = sceneOfPiece(scenes, p);
            const selected = selectedPiece === p.id;
            return (
              <li
                key={p.id}
                data-scene-piece={p.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-2 py-1.5",
                  selected ? "border-accent-2 bg-accent/10" : "border-line",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer text-left"
                  onClick={() => {
                    st.select({ kind: "piece", id: p.id });
                    ctx.seekSec(offsets[i]! + 0.01);
                  }}
                >
                  <span className="block truncate text-xs font-semibold">
                    {i + 1}. {scene?.name ?? "Scene"}
                  </span>
                  <span className="text-[11px] text-muted">{secs(pieceDuration(p))}</span>
                </button>
                <Button size="iconSm" variant="ghost" aria-label="Move earlier" disabled={i === 0} onClick={() => st.apply(moveScene(p.id, -1))}>
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="iconSm"
                  variant="ghost"
                  aria-label="Move later"
                  disabled={i === edit.video.length - 1}
                  onClick={() => st.apply(moveScene(p.id, 1))}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="iconSm"
                  variant="ghost"
                  aria-label="Delete scene"
                  disabled={edit.video.length <= 1}
                  onClick={() => st.apply(ops.rippleDeletePiece(p.id))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            );
          })}
        </ol>
      </Section>

      <Section title="Add a scene">
        <p className="text-xs text-muted">
          {selectedPiece ? "Goes after the selected scene." : "Goes at the end. Select a scene to add after it."}
        </p>
        {byVideo.map(([name, list]) => (
          <div key={name} className="flex flex-col gap-1">
            <p className="truncate text-[11px] font-semibold text-muted">{name}</p>
            <div className="flex flex-wrap gap-1.5">
              {list.map((s) => (
                <Button
                  key={s.id}
                  size="sm"
                  variant={used.has(s.id) ? "ghost" : "secondary"}
                  data-add-scene={s.id}
                  title={used.has(s.id) ? "Already in this video" : "Add this scene"}
                  onClick={() => st.apply(addScene(s, selectedPiece))}
                >
                  <Plus className="h-3 w-3" /> {secs(s.e - s.s)}
                </Button>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Sound">
        <Row label="Mute the video">
          <Switch checked={muted} onChange={(v) => st.apply(setMuted(v))} label="Mute" />
        </Row>
        <p className="text-xs text-muted">Music or a voiceover from the Media tab still plays.</p>
      </Section>

      <Section title="Captions">
        <Row label="Show captions">
          <Switch checked={edit.captions.enabled} onChange={(v) => st.apply(ops.setCaptionsEnabled(v))} label="Captions" />
        </Row>
        <p className="text-xs text-muted">Off for montages unless you turn them on. Their style is in the Captions tab.</p>
      </Section>

      <Section title="Hook title card" action={<Switch checked={edit.hook.enabled} onChange={(v) => st.apply(ops.setHook({ enabled: v }))} label="Hook card" />}>
        <Input
          aria-label="Montage hook text"
          value={edit.hook.text}
          placeholder="Text shown over the first seconds"
          onChange={(e) => st.apply(ops.setHook({ text: e.target.value, enabled: e.target.value.trim() ? true : edit.hook.enabled }), "hook-text")}
        />
        <p className="text-xs text-muted">Font, colours and duration are in the Overlays tab.</p>
      </Section>
    </div>
  );
}
