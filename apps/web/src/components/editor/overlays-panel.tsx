"use client";

import { DEFAULT_HOOK_STYLE, FONT_FILES, HOOK_STYLE_PRESETS, PROVIDERS, resolveHookStyle, type Provider } from "@klipz/shared";
import { Button } from "@/components/ui/button";
import { Input, Switch } from "@/components/ui/primitives";
import * as ops from "@/lib/editor/ops";
import { cn } from "@/lib/utils";
import { HookMini } from "./caption-mini";
import { ColorInput, Row, Section, SelectInput, Slider } from "./controls";
import { useEdit, useEditorCtx, useView } from "./editor-context";

/** Shadow choices for the hook text; every one is a plain CSS text-shadow the fast renderer draws. */
const HOOK_SHADOWS: { value: string; label: string }[] = [
  { value: "none", label: "None" },
  { value: "0 6px 0 rgba(0,0,0,0.55)", label: "Hard drop" },
  { value: "0 3px 12px rgba(0,0,0,0.7)", label: "Soft drop" },
  { value: "0 0 24px rgba(255,255,255,0.85)", label: "White glow" },
];

const PROVIDER_LABEL: Record<Provider, string> = {
  tiktok: "TikTok",
  instagram: "Instagram Reels",
  youtube: "YouTube Shorts",
  facebook: "Facebook Reels",
  x: "X",
  linkedin: "LinkedIn",
};

/** Look of the hook title card's text: ready-made styles plus font, size, colours, card, outline, shadow, dim. */
function HookStyleSection() {
  const ctx = useEditorCtx();
  const edit = useEdit();
  const st = ctx.store.getState();
  const style = resolveHookStyle(edit.hook);
  const custom = edit.hook.style !== undefined && Object.keys(edit.hook.style).length > 0;
  const hasBox = style.boxColor !== "transparent";
  const set = <K extends keyof typeof style>(key: K, value: (typeof style)[K]) => st.apply(ops.setHookStyle(key, value), `hook:${String(key)}`);
  const shadowOptions = HOOK_SHADOWS.some((s) => s.value === style.shadow) ? HOOK_SHADOWS : [...HOOK_SHADOWS, { value: style.shadow, label: "From the style" }];
  return (
    <Section
      title="Hook text style"
      action={
        <Button size="sm" variant="ghost" disabled={!custom} onClick={() => st.apply(ops.resetHookStyle())}>
          Reset
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Hook style">
        {HOOK_STYLE_PRESETS.map((p) => {
          const selected = custom ? edit.hook.style?.presetId === p.presetId : p.presetId === "classic";
          return (
            <button
              key={p.presetId}
              type="button"
              role="radio"
              aria-checked={selected}
              data-hook-preset={p.presetId}
              onClick={() => st.apply(ops.applyHookPreset(p.presetId))}
              className={cn(
                "flex h-[72px] cursor-pointer flex-col items-center justify-between overflow-hidden rounded-lg border bg-gradient-to-br from-slate-700 to-slate-900 p-1.5",
                selected ? "border-accent-2 ring-1 ring-accent-2" : "border-line hover:border-accent/60",
              )}
            >
              <span className="flex flex-1 items-center">
                <HookMini style={p} scale={0.17} />
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
      <Row label="Capital letters">
        <Switch checked={style.uppercase} onChange={(v) => set("uppercase", v)} label="Hook text in capital letters" />
      </Row>
      <ColorInput label="Text colour" value={style.color} onChange={(v) => set("color", v)} />
      <Row label="Card behind text">
        <Switch
          checked={hasBox}
          onChange={(v) => set("boxColor", v ? (DEFAULT_HOOK_STYLE.boxColor) : "transparent")}
          label="Card behind the hook text"
        />
      </Row>
      {hasBox ? <ColorInput label="Card colour" value={style.boxColor} onChange={(v) => set("boxColor", v)} /> : null}
      <Slider label="Outline" value={style.strokeWidth} min={0} max={30} step={1} onChange={(v) => set("strokeWidth", v)} format={(v) => (v ? `${v}px` : "Off")} />
      {style.strokeWidth > 0 ? <ColorInput label="Outline colour" value={style.strokeColor} onChange={(v) => set("strokeColor", v)} /> : null}
      <SelectInput<string> label="Shadow" value={style.shadow} options={shadowOptions} onChange={(v) => set("shadow", v)} />
      <Slider label="Darken video" value={style.dim} min={0} max={0.8} step={0.02} onChange={(v) => set("dim", v)} format={(v) => `${Math.round(v * 100)}%`} />
    </Section>
  );
}

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
