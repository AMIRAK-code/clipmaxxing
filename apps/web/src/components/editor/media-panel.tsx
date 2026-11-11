"use client";

import { totalDuration } from "@klipz/shared";
import { Film, Music, Mic, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/primitives";
import { readMediaDuration, uploadAsset } from "@/lib/editor/assets-client";
import * as ops from "@/lib/editor/ops";
import { NumberInput, Row, Section, SelectInput, Slider } from "./controls";
import { useEdit, useEditor, useEditorCtx } from "./editor-context";

const basename = (s: string): string => decodeURIComponent(s.split("/").pop() ?? s);

export function MediaPanel() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const selection = useEditor((s) => s.selection);
  const st = ctx.store.getState();
  const total = totalDuration(edit.video);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const brollInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const voiceInput = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined, mode: "broll" | "music" | "voiceover") => {
    if (!file) return;
    setError(null);
    setBusy(file.name);
    try {
      const at = Math.min(ctx.getTime(), Math.max(0, total - 0.5));
      const dur = await readMediaDuration(file);
      const asset = await uploadAsset(file);
      const room = Math.max(0.5, total - at);
      if (mode === "broll") {
        if (asset.kind === "audio") throw new Error("B-roll must be a video or an image.");
        st.addBroll({ src: asset.key, kind: asset.kind === "image" ? "image" : "video", start: at, duration: Math.min(dur ?? 3, room, asset.kind === "image" ? 3 : Infinity) });
      } else {
        if (asset.kind !== "audio" && asset.kind !== "video") throw new Error("Choose an audio file.");
        st.addAudio({ src: asset.key, kind: mode, start: mode === "music" ? 0 : at, duration: Math.min(dur ?? total, mode === "music" ? total : room) });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  };

  const broll = selection?.kind === "broll" ? edit.broll.find((b) => b.id === selection.id) : undefined;
  const audio = selection?.kind === "audio" ? edit.audio.find((a) => a.id === selection.id) : undefined;

  return (
    <div>
      <Section title="B-roll">
        <input ref={brollInput} type="file" accept="video/*,image/*" hidden data-testid="broll-file" onChange={(e) => { void handle(e.target.files?.[0], "broll"); e.target.value = ""; }} />
        <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => brollInput.current?.click()}>
          <Film className="h-3.5 w-3.5" aria-hidden /> Add video / image at playhead
        </Button>
        <ItemList
          items={edit.broll.map((b) => ({ id: b.id, label: basename(b.src), sub: `${b.start.toFixed(1)}s · ${b.duration.toFixed(1)}s · ${b.fit}` }))}
          kind="broll"
        />
        {broll ? (
          <div className="flex flex-col gap-2.5 rounded-lg border border-line p-2.5">
            <NumberInput label="Start (s)" value={broll.start} min={0} max={total} onChange={(v) => st.apply(ops.updateBroll(broll.id, { start: v }), `broll-start:${broll.id}`)} />
            <NumberInput label="Duration (s)" value={broll.duration} min={ops.MIN_ITEM_SEC} onChange={(v) => st.apply(ops.updateBroll(broll.id, { duration: v }), `broll-dur:${broll.id}`)} />
            <SelectInput<"cover" | "pip">
              label="Layout"
              value={broll.fit}
              options={[
                { value: "cover", label: "Cover (full frame)" },
                { value: "pip", label: "Picture in picture" },
              ]}
              onChange={(v) => st.apply(ops.updateBroll(broll.id, { fit: v }))}
            />
            {broll.kind === "video" ? (
              <Slider label="Volume" value={broll.volume} min={0} max={1.5} step={0.05} onChange={(v) => st.apply(ops.updateBroll(broll.id, { volume: v }), `broll-vol:${broll.id}`)} format={(v) => `${Math.round(v * 100)}%`} />
            ) : null}
            <Row label="Duck main audio">
              <Switch checked={broll.duck} onChange={(v) => st.apply(ops.updateBroll(broll.id, { duck: v }))} label="Duck main audio" />
            </Row>
            <Button size="sm" variant="danger" onClick={() => st.deleteSelection()}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
            </Button>
          </div>
        ) : null}
      </Section>

      <Section title="Audio">
        <input ref={audioInput} type="file" accept="audio/*" hidden onChange={(e) => { void handle(e.target.files?.[0], "music"); e.target.value = ""; }} />
        <input ref={voiceInput} type="file" accept="audio/*" hidden onChange={(e) => { void handle(e.target.files?.[0], "voiceover"); e.target.value = ""; }} />
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => audioInput.current?.click()}>
            <Music className="h-3.5 w-3.5" aria-hidden /> Music
          </Button>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => voiceInput.current?.click()}>
            <Mic className="h-3.5 w-3.5" aria-hidden /> Voiceover
          </Button>
        </div>
        <ItemList items={edit.audio.map((a) => ({ id: a.id, label: basename(a.src), sub: `${a.kind} · ${a.start.toFixed(1)}s · ${a.duration.toFixed(1)}s` }))} kind="audio" />
        {audio ? (
          <div className="flex flex-col gap-2.5 rounded-lg border border-line p-2.5">
            <NumberInput label="Start (s)" value={audio.start} min={0} max={total} onChange={(v) => st.apply(ops.updateAudio(audio.id, { start: v }), `audio-start:${audio.id}`)} />
            <NumberInput label="Duration (s)" value={audio.duration} min={ops.MIN_ITEM_SEC} onChange={(v) => st.apply(ops.updateAudio(audio.id, { duration: v }), `audio-dur:${audio.id}`)} />
            <NumberInput label="Trim start (s)" value={audio.srcOffset} min={0} onChange={(v) => st.apply(ops.updateAudio(audio.id, { srcOffset: v }), `audio-off:${audio.id}`)} />
            <Slider label="Volume" value={audio.volume} min={0} max={1.5} step={0.05} onChange={(v) => st.apply(ops.updateAudio(audio.id, { volume: v }), `audio-vol:${audio.id}`)} format={(v) => `${Math.round(v * 100)}%`} />
            <Row label="Duck main audio">
              <Switch checked={audio.duck} onChange={(v) => st.apply(ops.updateAudio(audio.id, { duck: v }))} label="Duck main audio" />
            </Row>
            <Button size="sm" variant="danger" onClick={() => st.deleteSelection()}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
            </Button>
          </div>
        ) : null}
      </Section>

      {busy ? (
        <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted">
          <Upload className="h-3.5 w-3.5 animate-pulse" aria-hidden /> Uploading {busy}…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-3 py-2 text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ItemList({ items, kind }: { items: Array<{ id: string; label: string; sub: string }>; kind: "broll" | "audio" }) {
  const ctx = useEditorCtx();
  const selection = useEditor((s) => s.selection);
  if (items.length === 0) return <p className="text-xs text-muted">Nothing added yet.</p>;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((it) => (
        <li key={it.id}>
          <button
            type="button"
            aria-pressed={selection?.kind === kind && selection.id === it.id}
            onClick={() => ctx.store.getState().select({ kind, id: it.id })}
            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-line px-2 py-1.5 text-left text-xs hover:bg-panel-2 aria-pressed:border-accent-2 aria-pressed:bg-accent/15"
          >
            <span className="min-w-0 truncate font-semibold">{it.label}</span>
            <span className="shrink-0 text-muted">{it.sub}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
