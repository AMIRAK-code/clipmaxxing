"use client";

import { DEFAULT_HOOK_STYLE_ID, FONT_FILES, HOOK_PRESETS, PROVIDERS, isTransparent, resolveHookStyle, type HookStyle, type Provider } from "@klipz/shared";
import { Button } from "@/components/ui/button";
import { Input, Switch } from "@/components/ui/primitives";
import * as ops from "@/lib/editor/ops";
import { cn } from "@/lib/utils";
import { ColorInput, Row, Section, SelectInput, Slider } from "./controls";
import { useEdit, useEditorCtx, useView } from "./editor-context";
import { HookMini } from "./hook-mini";

type HookField = Exclude<keyof HookStyle, "id" | "name">;

/** Box colour used when the box is switched on for a preset that has none. */
const DEFAULT_BOX = "#7C3AED";

function HookStyleSection() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const st = ctx.store.getState();
  const styleId = edit.hook.styleId ?? DEFAULT_HOOK_STYLE_ID;
  const style = resolveHookStyle(edit.hook);
  const preset = HOOK_PRESETS.find((p) => p.id === styleId) ?? HOOK_PRESETS[0]!;
  const set = <K extends HookField>(key: K, value: HookStyle[K]) => st.apply(ops.setHookOverride(key, value), `hook:${key}`);
  const hasOverrides = Object.keys(edit.hook.overrides ?? {}).length > 0;
  const boxed = !isTransparent(style.background);
  return (
    <Section
      title="Hook text style"
      action={
        <Button size="sm" variant="ghost" disabled={!hasOverrides} onClick={() => st.apply(ops.resetHookOverrides())}>
          Reset
        </Button>
      }
    >
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Hook style">
        {HOOK_PRESETS.map((p) => {
          const selected = p.id === styleId;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected}
              data-hook-preset={p.id}
              onClick={() => st.apply(ops.setHookStyle(p.id))}
              className={cn(
                "flex h-[64px] cursor-pointer flex-col items-center justify-between overflow-hidden rounded-lg border bg-gradient-to-br from-slate-500 to-slate-800 p-1.5",
                selected ? "border-accent-2 ring-1 ring-accent-2" : "border-line hover:border-accent/60",
              )}
            >
              <span className="flex flex-1 items-center">
                <HookMini style={selected ? style : p} />
              </span>
              <span className="text-[10px] font-semibold text-fg/80">{p.name}</span>
            </button>
          );
        })}
      </div>
      <SelectInput<string>
        label="Font"
        value={style.fontFamily}
        options={Object.keys(FONT_FILES).map((f) => ({ value: f, label: f }))}
        onChange={(v) => set("fontFamily", v)}
      />
      <Slider label="Size" value={style.fontSize} min={40} max={180} step={2} onChange={(v) => set("fontSize", v)} format={(v) => `${v}px`} />
      <ColorInput label="Text colour" value={style.color} onChange={(v) => set("color", v)} />
      <Row label="Box">
        <Switch
          checked={boxed}
          onChange={(v) => set("background", v ? (isTransparent(preset.background) ? DEFAULT_BOX : preset.background) : "transparent")}
          label="Box behind the text"
        />
      </Row>
      {boxed ? <ColorInput label="Box colour" value={style.background} onChange={(v) => set("background", v)} /> : null}
      <Slider label="Outline" value={style.strokeWidth} min={0} max={24} step={1} onChange={(v) => set("strokeWidth", v)} format={(v) => (v > 0 ? `${v}px` : "off")} />
      {style.strokeWidth > 0 ? <ColorInput label="Outline colour" value={style.strokeColor} onChange={(v) => set("strokeColor", v)} /> : null}
      <Row label="Uppercase">
        <Switch checked={style.uppercase} onChange={(v) => set("uppercase", v)} label="Hook uppercase" />
      </Row>
    </Section>
  );
}

const PROVIDER_LABEL: Record<Provider, string> = {
  tiktok: "TikTok",
  instagram: "Instagram Reels",
  youtube: "YouTube Shorts",
  facebook: "Facebook Reels",
  x: "X",
  linkedin: "LinkedIn",
};

export function OverlaysPanel() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const showSafe = useView((v) => v.showSafeZone);
  const st = ctx.store.getState();
  return (
    <div>
      <Section title="Hook title card" action={<Switch checked={edit.hook.enabled} onChange={(v) => st.apply(ops.setHook({ enabled: v }))} label="Hook card" />}>
        <Input
          aria-label="Hook text"
          value={edit.hook.text}
          placeholder="Opening hook text"
          maxLength={120}
          onChange={(e) => st.apply(ops.setHook({ text: e.target.value }), "hook-text")}
        />
        <Slider label="Duration" value={edit.hook.durationSec} min={0.5} max={8} step={0.1} onChange={(v) => st.apply(ops.setHook({ durationSec: v }), "hook-dur")} format={(v) => `${v.toFixed(1)}s`} />
        <p className="text-xs text-muted">Shown over the first seconds of the clip.</p>
      </Section>

      <HookStyleSection />

      <Section title="Progress bar" action={<Switch checked={edit.progressBar.enabled} onChange={(v) => st.apply(ops.setProgressBar({ enabled: v }))} label="Progress bar" />}>
        <ColorInput label="Colour" value={edit.progressBar.color} onChange={(v) => st.apply(ops.setProgressBar({ color: v }), "pb-color")} />
        <SelectInput<"top" | "bottom">
          label="Position"
          value={edit.progressBar.position}
          options={[
            { value: "bottom", label: "Bottom" },
            { value: "top", label: "Top" },
          ]}
          onChange={(v) => st.apply(ops.setProgressBar({ position: v }))}
        />
        <Slider label="Height" value={edit.progressBar.height} min={2} max={40} step={1} onChange={(v) => st.apply(ops.setProgressBar({ height: v }), "pb-h")} format={(v) => `${v}px`} />
      </Section>

      <Section title="Safe zone">
        <SelectInput<Provider | "none">
          label="Platform"
          value={edit.safeZone}
          options={[{ value: "none", label: "None" }, ...PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))]}
          onChange={(v) => st.apply(ops.setSafeZone(v))}
        />
        <Row label="Show overlay in preview">
          <Switch checked={showSafe} onChange={(v) => ctx.view.setState({ showSafeZone: v })} label="Show safe zone overlay" />
        </Row>
        <p className="text-xs text-muted">The overlay shows where platform UI covers the video. It is never rendered into the export; captions and the hook card stay clear of it.</p>
      </Section>
    </div>
  );
}
