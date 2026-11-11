"use client";

import { CAPTION_PRESETS, resolveCaptionStyle, srcToOut, type CaptionStyle, type CaptionWord } from "@klipz/shared";
import { Eye, EyeOff, Sparkles, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/primitives";
import * as ops from "@/lib/editor/ops";
import { cn } from "@/lib/utils";
import { CaptionMini } from "./caption-mini";
import { ColorInput, Row, Section, SelectInput, Slider } from "./controls";
import { useEdit, useEditor, useEditorCtx } from "./editor-context";

export function CaptionsPanel() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const st = ctx.store.getState();
  const style = resolveCaptionStyle(edit.captions.styleId, edit.captions.overrides);
  const set = <K extends keyof CaptionStyle>(key: K, value: CaptionStyle[K]) => st.apply(ops.setCaptionOverride(key, value), `cap:${key}`);
  const hasOverrides = Object.keys(edit.captions.overrides).length > 0;

  return (
    <div>
      <Section
        title="Captions"
        action={<Switch checked={edit.captions.enabled} onChange={(v) => st.apply(ops.setCaptionsEnabled(v))} label="Captions on" />}
      >
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Caption style">
          {CAPTION_PRESETS.map((p) => {
            const selected = p.id === edit.captions.styleId;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-preset={p.id}
                onClick={() => st.apply(ops.setCaptionStyle(p.id))}
                className={cn(
                  "flex h-[72px] cursor-pointer flex-col items-center justify-between overflow-hidden rounded-lg border bg-gradient-to-br from-slate-700 to-slate-900 p-1.5",
                  selected ? "border-accent-2 ring-1 ring-accent-2" : "border-line hover:border-accent/60",
                )}
              >
                <span className="flex flex-1 items-center">
                  <CaptionMini style={selected ? style : p} scale={0.2} />
                </span>
                <span className="text-[10px] font-semibold text-fg/80">{p.name}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        title="Style overrides"
        action={
          <Button size="sm" variant="ghost" disabled={!hasOverrides} onClick={() => st.apply(ops.resetCaptionOverrides())}>
            Reset
          </Button>
        }
      >
        <Slider label="Font size" value={style.fontSize} min={30} max={180} step={2} onChange={(v) => set("fontSize", v)} format={(v) => `${v}px`} />
        <Slider label="Position" value={style.position} min={0.1} max={0.95} step={0.01} onChange={(v) => set("position", v)} format={(v) => `${Math.round(v * 100)}%`} />
        <SelectInput<number>
          label="Words per page"
          value={style.wordsPerPage}
          options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))}
          onChange={(v) => set("wordsPerPage", v as CaptionStyle["wordsPerPage"])}
        />
        <SelectInput<CaptionStyle["anim"]>
          label="Animation"
          value={style.anim}
          options={(["none", "pop", "bounce", "fade", "slide-up"] as const).map((v) => ({ value: v, label: v }))}
          onChange={(v) => set("anim", v)}
        />
        <SelectInput<CaptionStyle["highlight"]>
          label="Highlight"
          value={style.highlight}
          options={(["none", "color", "box", "karaoke", "scale"] as const).map((v) => ({ value: v, label: v }))}
          onChange={(v) => set("highlight", v)}
        />
        <ColorInput label="Text colour" value={style.color} onChange={(v) => set("color", v)} />
        <ColorInput label="Active word" value={style.activeColor} onChange={(v) => set("activeColor", v)} />
        <ColorInput label="Emphasis" value={style.emphasisColor} onChange={(v) => set("emphasisColor", v)} />
        <Row label="Uppercase">
          <Switch checked={style.uppercase} onChange={(v) => set("uppercase", v)} label="Uppercase" />
        </Row>
        <Row label="Emoji">
          <Switch checked={style.emoji} onChange={(v) => set("emoji", v)} label="Emoji" />
        </Row>
      </Section>

      <Section
        title={`Words (${edit.captions.words.length})`}
        action={
          <Button size="sm" variant="secondary" onClick={() => st.apply(ops.autoEmphasise())} title="Highlight keywords automatically">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Auto-emphasise
          </Button>
        }
      >
        <WordList />
      </Section>
    </div>
  );
}

const ROW = 34;
const VIEW_H = 260;

/** Windowed word list: only the rows in view are mounted, so long clips stay cheap. */
function WordList() {
  const ctx = useEditorCtx();
  const words = useEditor((s) => s.edit.captions.words);
  const selection = useEditor((s) => s.selection);
  const [top, setTop] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selection?.kind !== "word" || !ref.current) return;
    const i = words.findIndex((w) => w.id === selection.id);
    if (i < 0) return;
    const y = i * ROW;
    const el = ref.current;
    if (y < el.scrollTop || y + ROW > el.scrollTop + VIEW_H) el.scrollTop = Math.max(0, y - ROW * 2);
  }, [selection, words]);

  const first = Math.max(0, Math.floor(top / ROW) - 4);
  const last = Math.min(words.length, Math.ceil((top + VIEW_H) / ROW) + 4);
  return (
    <div ref={ref} className="overflow-y-auto rounded-lg border border-line bg-bg" style={{ height: VIEW_H }} onScroll={(e) => setTop(e.currentTarget.scrollTop)} data-testid="word-list">
      <div style={{ height: words.length * ROW, position: "relative" }}>
        {words.slice(first, last).map((w, k) => (
          <WordRow key={w.id} word={w} y={(first + k) * ROW} selected={selection?.kind === "word" && selection.id === w.id} onSelect={() => ctx.store.getState().select({ kind: "word", id: w.id })} />
        ))}
      </div>
    </div>
  );
}

function WordRow({ word, y, selected, onSelect }: { word: CaptionWord; y: number; selected: boolean; onSelect: () => void }) {
  const ctx = useEditorCtx();
  const st = ctx.store.getState();
  const [draft, setDraft] = useState(word.w);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(word.w);
  }, [word.w]);

  const commit = (text: string, key?: string) => st.apply(ops.editWord(word.id, text), key);
  return (
    <div
      className={cn("absolute inset-x-0 flex items-center gap-1.5 px-1.5", selected && "bg-accent/15", word.hidden && "opacity-50")}
      style={{ top: y, height: ROW }}
      data-word-row={word.id}
    >
      <button type="button" className="w-9 shrink-0 cursor-pointer text-left text-[10px] tabular-nums text-muted hover:text-fg" onClick={() => {
          onSelect();
          const t = srcToOut(ctx.store.getState().edit.video, (word.s + word.e) / 2);
          if (t != null) ctx.seekSec(t);
        }} aria-label={`Select word at ${word.s.toFixed(1)} seconds`} tabIndex={-1}>
        {word.s.toFixed(1)}
      </button>
      <input
        aria-label={`Word at ${word.s.toFixed(1)} seconds`}
        value={draft}
        onFocus={() => {
          focused.current = true;
          onSelect();
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          const t = e.target.value.trim();
          // single words update the preview live; multi-word / empty edits wait for blur or Enter
          if (t && !/\s/.test(t)) commit(t, `word:${word.id}`);
        }}
        onBlur={() => {
          focused.current = false;
          if (draft.trim() !== word.w) commit(draft);
          else setDraft(word.w);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        className="h-7 min-w-0 flex-1 rounded border border-line bg-panel px-1.5 text-xs"
      />
      <input
        aria-label="Emoji"
        value={word.emoji ?? ""}
        placeholder="🙂"
        maxLength={4}
        onChange={(e) => st.apply(ops.setWordEmoji(word.id, e.target.value), `emoji:${word.id}`)}
        className="h-7 w-9 rounded border border-line bg-panel text-center text-xs"
      />
      <button
        type="button"
        aria-label={word.emph ? "Remove emphasis" : "Emphasise word"}
        aria-pressed={Boolean(word.emph)}
        onClick={() => st.apply(ops.toggleWordEmphasis(word.id))}
        className={cn("h-7 w-7 shrink-0 cursor-pointer rounded hover:bg-panel-2", word.emph ? "text-good" : "text-muted")}
      >
        <Star className="mx-auto h-3.5 w-3.5" fill={word.emph ? "currentColor" : "none"} aria-hidden />
      </button>
      <button
        type="button"
        aria-label={word.hidden ? "Show word" : "Hide word"}
        aria-pressed={Boolean(word.hidden)}
        onClick={() => st.apply(ops.toggleWordHidden(word.id))}
        className="h-7 w-7 shrink-0 cursor-pointer rounded text-muted hover:bg-panel-2"
      >
        {word.hidden ? <EyeOff className="mx-auto h-3.5 w-3.5" aria-hidden /> : <Eye className="mx-auto h-3.5 w-3.5" aria-hidden />}
      </button>
    </div>
  );
}
