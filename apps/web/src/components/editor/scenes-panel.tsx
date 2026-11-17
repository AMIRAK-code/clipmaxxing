"use client";

import { pieceDuration, pieceOffsets, type MontageScene, type Word } from "@klipz/shared";
import { ArrowDown, ArrowUp, Plus, Trash2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/primitives";
import { sceneForPiece } from "@/lib/editor/montage";
import * as ops from "@/lib/editor/ops";
import { cn, fileUrl } from "@/lib/utils";
import { Row, Section } from "./controls";
import { useEdit, useEditor, useEditorCtx } from "./editor-context";

/** Caption words (pool times) inside a scene, with the ids the worker gives them (index in the pool's words). */
function sceneWords(words: Word[], s: MontageScene) {
  const out: { id: string; w: string; s: number; e: number }[] = [];
  words.forEach((w, i) => {
    const mid = (w.s + w.e) / 2;
    if (s.pool_start <= mid && mid < s.pool_end) out.push({ id: `w${i}_${Math.round(w.s * 1000)}`, w: w.w.trim(), s: w.s, e: w.e });
  });
  return out;
}

function Thumb({ scene }: { scene: MontageScene | undefined }) {
  const src = fileUrl(scene?.thumb_key);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className="h-14 w-8 shrink-0 rounded object-cover" loading="lazy" />
  ) : (
    <span className="h-14 w-8 shrink-0 rounded bg-panel-2" />
  );
}

/** A montage's scenes: order, delete, add from the pool, and sound on/off. */
export function ScenesPanel({ words }: { words: Word[] }) {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const selection = useEditor((s) => s.selection);
  const st = ctx.store.getState();
  const scenes = ctx.montage?.scenes ?? [];
  const offsets = pieceOffsets(edit.video);
  const selectedId = selection?.kind === "piece" ? selection.id : null;
  const used = new Set(edit.video.map((p) => sceneForPiece(scenes, p)?.id).filter(Boolean));
  const name = (s: MontageScene | undefined) => s?.input_name?.replace(/\.[^.]+$/, "") ?? "Scene";

  return (
    <div>
      <Section title="Sound">
        <Row label="Mute the montage">
          <Switch checked={edit.volume === 0} onChange={(v) => st.apply(ops.setVolume(v ? 0 : 1))} label="Mute the montage" />
        </Row>
        {edit.volume === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <VolumeX className="h-3.5 w-3.5" /> The montage is exported without sound. Add music on the Media tab if you like.
          </p>
        ) : null}
      </Section>

      <Section title={`Scenes in this montage (${edit.video.length})`}>
        <ol className="flex flex-col gap-1.5" aria-label="Scenes in this montage">
          {edit.video.map((p, i) => {
            const s = sceneForPiece(scenes, p);
            const selected = p.id === selectedId;
            return (
              <li
                key={p.id}
                data-scene-piece={p.id}
                className={cn("flex items-center gap-2 rounded-lg border p-1.5", selected ? "border-accent-2 bg-accent/15" : "border-line")}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  onClick={() => {
                    st.select({ kind: "piece", id: p.id });
                    ctx.seekSec(offsets[i]! + 0.01);
                  }}
                  aria-label={`Scene ${i + 1}: ${name(s)}, ${pieceDuration(p).toFixed(1)} seconds`}
                >
                  <Thumb scene={s} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">
                      {i + 1}. {name(s)}
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {pieceDuration(p).toFixed(1)} s{s?.text ? ` · “${s.text}”` : ""}
                    </span>
                  </span>
                </button>
                <span className="flex shrink-0 flex-col">
                  <button type="button" aria-label={`Move scene ${i + 1} earlier`} disabled={i === 0} onClick={() => st.apply(ops.movePiece(p.id, -1))} className="text-muted hover:text-fg disabled:opacity-30">
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move scene ${i + 1} later`}
                    disabled={i === edit.video.length - 1}
                    onClick={() => st.apply(ops.movePiece(p.id, 1))}
                    className="text-muted hover:text-fg disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </span>
                <button
                  type="button"
                  aria-label={`Delete scene ${i + 1}`}
                  disabled={edit.video.length <= 1}
                  onClick={() => st.apply(ops.rippleDeletePiece(p.id))}
                  className="shrink-0 text-muted hover:text-bad disabled:opacity-30"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ol>
      </Section>

      <Section title={`Add a scene (${scenes.length} found)`}>
        <p className="text-xs text-muted">{selectedId ? "Added after the selected scene." : "Added at the end. Select a scene to add after it."}</p>
        <ul className="flex flex-col gap-1.5" aria-label="Scenes you can add">
          {scenes.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-lg border border-line p-1.5" data-pool-scene={s.id}>
              <Thumb scene={s} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold">{name(s)}</span>
                <span className="block truncate text-[11px] text-muted">
                  {(s.pool_end - s.pool_start).toFixed(1)} s{used.has(s.id) ? " · in this montage" : ""}
                  {s.text ? ` · “${s.text}”` : ""}
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Add scene from ${name(s)}`}
                onClick={() => st.apply(ops.insertPiece({ srcStart: s.pool_start, srcEnd: s.pool_end }, selectedId, sceneWords(words, s)))}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
