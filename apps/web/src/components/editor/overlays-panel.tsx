"use client";

import { PROVIDERS, type Provider } from "@klipz/shared";
import { Input, Switch } from "@/components/ui/primitives";
import * as ops from "@/lib/editor/ops";
import { ColorInput, Row, Section, SelectInput, Slider } from "./controls";
import { useEdit, useEditorCtx, useView } from "./editor-context";

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
