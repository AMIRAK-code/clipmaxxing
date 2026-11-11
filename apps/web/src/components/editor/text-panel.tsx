"use client";

import { FONT_FILES, totalDuration, type CaptionAnim } from "@klipz/shared";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/primitives";
import * as ops from "@/lib/editor/ops";
import { cn } from "@/lib/utils";
import { ColorInput, NumberInput, Row, Section, SelectInput, Slider } from "./controls";
import { useEdit, useEditor, useEditorCtx } from "./editor-context";

export function TextPanel() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const selection = useEditor((s) => s.selection);
  const st = ctx.store.getState();
  const total = totalDuration(edit.video);
  const item = selection?.kind === "text" ? edit.texts.find((t) => t.id === selection.id) : undefined;
  const upd = (patch: Parameters<typeof ops.updateText>[1], key?: string) => item && st.apply(ops.updateText(item.id, patch), key ? `${key}:${item.id}` : undefined);

  return (
    <div>
      <Section
        title={`Text items (${edit.texts.length})`}
        action={
          <Button size="sm" variant="secondary" onClick={() => st.addText({ start: Math.min(ctx.getTime(), Math.max(0, total - 1)) })}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add at playhead
          </Button>
        }
      >
        {edit.texts.length === 0 ? <p className="text-xs text-muted">Add titles, call-outs or stickers. Drag them on the preview to position them.</p> : null}
        <ul className="flex flex-col gap-1">
          {edit.texts.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  st.select({ kind: "text", id: t.id });
                  ctx.seekSec(t.start);
                }}
                className={cn("flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border px-2 py-1.5 text-left text-xs", item?.id === t.id ? "border-accent-2 bg-accent/15" : "border-line hover:bg-panel-2")}
              >
                <span className="min-w-0 truncate font-semibold">{t.text || "(empty)"}</span>
                <span className="shrink-0 tabular-nums text-muted">{t.start.toFixed(1)}s</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      {item ? (
        <Section title="Selected text">
          <Textarea aria-label="Text content" rows={2} value={item.text} onChange={(e) => upd({ text: e.target.value }, "text")} />
          <NumberInput label="Start (s)" value={item.start} min={0} max={total} onChange={(v) => upd({ start: v }, "tstart")} />
          <NumberInput label="Duration (s)" value={item.duration} min={ops.MIN_ITEM_SEC} onChange={(v) => upd({ duration: v }, "tdur")} />
          <Slider label="Font size" value={item.fontSize} min={24} max={220} step={2} onChange={(v) => upd({ fontSize: v }, "tsize")} format={(v) => `${v}px`} />
          <SelectInput<string>
            label="Font"
            value={item.fontFamily}
            options={Object.keys(FONT_FILES).map((f) => ({ value: f, label: f }))}
            onChange={(v) => upd({ fontFamily: v, fontWeight: FONT_FILES[v]?.[0]?.weight ?? 700 })}
          />
          <ColorInput label="Colour" value={item.color} onChange={(v) => upd({ color: v }, "tcolor")} />
          <Row label="Background">
            <Button size="sm" variant="ghost" onClick={() => upd({ background: "transparent" })} disabled={item.background === "transparent"}>
              None
            </Button>
            <input
              type="color"
              aria-label="Background colour"
              value={/^#[0-9a-f]{6}$/i.test(item.background) ? item.background : "#000000"}
              onChange={(e) => upd({ background: e.target.value }, "tbg")}
              className="h-7 w-9 cursor-pointer rounded border border-line bg-transparent p-0.5"
            />
          </Row>
          <SelectInput<CaptionAnim>
            label="Entrance"
            value={item.anim}
            options={(["none", "pop", "bounce", "fade", "slide-up"] as const).map((v) => ({ value: v, label: v }))}
            onChange={(v) => upd({ anim: v })}
          />
          <p className="text-[11px] text-muted">
            Position: {Math.round(item.x * 100)}% / {Math.round(item.y * 100)}%. Drag on the preview; double-click the dashed box to edit inline.
          </p>
          <Button size="sm" variant="danger" onClick={() => st.deleteSelection()}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove text
          </Button>
        </Section>
      ) : null}
    </div>
  );
}
