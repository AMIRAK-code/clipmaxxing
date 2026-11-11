"use client";

import type { Job, Word } from "@klipz/shared";
import { Captions, Clapperboard, Download, Film, Layers, Type } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import type { RenderView } from "@/server/renders";
import { CaptionsPanel } from "./captions-panel";
import type { InspectorTab } from "./editor-context";
import { ExportPanel } from "./export-panel";
import { MediaPanel } from "./media-panel";
import { OverlaysPanel } from "./overlays-panel";
import { TextPanel } from "./text-panel";
import { VideoPanel } from "./video-panel";

const TABS: Array<{ id: InspectorTab; label: string; icon: typeof Captions }> = [
  { id: "captions", label: "Captions", icon: Captions },
  { id: "video", label: "Video", icon: Clapperboard },
  { id: "media", label: "Media", icon: Film },
  { id: "text", label: "Text", icon: Type },
  { id: "overlays", label: "Overlays", icon: Layers },
  { id: "export", label: "Export", icon: Download },
];

export function Inspector({
  tab,
  setTab,
  initialRenders,
  initialJobs,
}: {
  tab: InspectorTab;
  setTab: (t: InspectorTab) => void;
  words: Word[];
  initialRenders: RenderView[];
  initialJobs: Job[];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length]!;
    setTab(t.id);
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${t.id}"]`)?.focus();
  };
  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-panel" aria-label="Inspector">
      <div ref={listRef} role="tablist" aria-label="Inspector sections" onKeyDown={onKey} className="flex shrink-0 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            data-tab={t.id}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex flex-1 cursor-pointer flex-col items-center gap-0.5 border-b-2 px-1 py-1.5 text-[10px] font-semibold",
              tab === t.id ? "border-accent-2 text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            <t.icon className="h-4 w-4" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {tab === "captions" ? <CaptionsPanel /> : null}
        {tab === "video" ? <VideoPanel /> : null}
        {tab === "media" ? <MediaPanel /> : null}
        {tab === "text" ? <TextPanel /> : null}
        {tab === "overlays" ? <OverlaysPanel /> : null}
        {tab === "export" ? <ExportPanel initialRenders={initialRenders} initialJobs={initialJobs} /> : null}
      </div>
    </aside>
  );
}
