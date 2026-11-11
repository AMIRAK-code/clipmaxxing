"use client";

import { OUT_FPS, createDefaultEditState, type Clip, type Job, type SourceVideo, type Word } from "@klipz/shared";
import { normalizeEdit } from "@klipz/video";
import type { PlayerRef } from "@remotion/player";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Autosaver } from "@/lib/editor/autosave";
import { Playhead } from "@/lib/editor/playhead";
import { createEditorStore } from "@/lib/editor/store";
import { fileUrl } from "@/lib/utils";
import type { RenderView } from "@/server/renders";
import {
  clampToDuration,
  createSaveStore,
  createViewStore,
  EditorProvider,
  type EditorCtx,
  type InspectorTab,
} from "./editor-context";
import { EditorHeader } from "./header";
import { Inspector } from "./inspector";
import { Preview } from "./preview";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { Timeline } from "./timeline";
import { useEditorShortcuts } from "./use-shortcuts";

export interface ClipEditorProps {
  clip: Clip;
  source: SourceVideo | null;
  words: Word[];
  initialRenders: RenderView[];
  initialJobs: Job[];
}

export function ClipEditor(props: ClipEditorProps) {
  const { clip, source } = props;
  if (!source || !source.storage_key || source.status !== "ready" || !source.width || !source.height) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-bg p-6 text-center">
        <p className="text-lg font-bold">The source video is not available</p>
        <p className="max-w-md text-sm text-muted">
          {source?.status === "deleted" ? "The source file was cleaned up. Import it again to edit this clip." : "Wait for the video to finish importing, then reopen this clip."}
        </p>
        <Link href={`/projects/${clip.project_id}`} className="rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:bg-panel-2">
          Back to project
        </Link>
      </div>
    );
  }
  return <Loaded {...props} source={source} />;
}

function Loaded({ clip, source, words, initialRenders, initialJobs }: ClipEditorProps & { source: SourceVideo }) {
  const [state] = useState(() => {
    const hadEdit = clip.edit_state != null;
    const initial = hadEdit
      ? normalizeEdit(clip.edit_state!)
      : createDefaultEditState({
          start: clip.start_sec,
          end: clip.end_sec,
          words,
          hook: clip.hook,
          styleId: clip.caption_style_id ?? undefined,
          keywords: clip.score_breakdown && "keywords" in clip.score_breakdown ? ((clip.score_breakdown as unknown as { keywords?: string[] }).keywords ?? []) : [],
        });
    // The worker's default (hook card on when a hook exists) must match what the user sees.
    const seeded = hadEdit || !clip.hook ? initial : { ...initial, hook: { ...initial.hook, enabled: true } };
    return {
      hadEdit,
      initial: seeded,
      store: createEditorStore(seeded),
      playhead: new Playhead(),
      view: createViewStore(),
      save: createSaveStore(),
    };
  });
  const { store, playhead, view, save } = state;
  const playerRef = useRef<PlayerRef | null>(null);
  const autosaver = useRef<Autosaver | null>(null);
  const [tab, setTab] = useState<InspectorTab>("captions");
  const [help, setHelp] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ── autosave wiring ──────────────────────────────────────────────────
  useEffect(() => {
    const a = new Autosaver({
      clipId: clip.id,
      version: clip.edit_version,
      saved: state.hadEdit ? state.initial : null,
      onStatus: (info) => save.setState({ ...info, at: Date.now() }, true),
      onConflict: ({ edit_state }) => {
        store.getState().reset(normalizeEdit(edit_state!));
        setNotice("This clip was changed in another tab or by a background job. Loaded the newer version.");
      },
    });
    autosaver.current = a;
    let last = store.getState().edit;
    const unsub = store.subscribe((s) => {
      if (s.edit !== last) {
        last = s.edit;
        a.change(s.edit);
      }
    });
    if (!state.hadEdit) a.change(store.getState().edit); // persist the default edit on first autosave
    const hide = () => a.flushOnHide();
    const vis = () => {
      if (document.visibilityState === "hidden") hide();
    };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", vis);
      unsub();
      a.dispose();
      autosaver.current = null;
    };
  }, [clip.id, clip.edit_version, state, store, save]);

  useEffect(() => () => playhead.dispose(), [playhead]);

  // ── playback helpers ─────────────────────────────────────────────────
  const seekFrame = useCallback(
    (f: number) => {
      const frame = clampToDuration(store.getState().edit, f);
      playerRef.current?.seekTo(frame);
      playhead.set(frame);
    },
    [store, playhead],
  );
  const ctx = useMemo<EditorCtx>(
    () => ({
      store,
      playhead,
      playerRef,
      autosaver,
      view,
      save,
      clip: { id: clip.id, projectId: clip.project_id, title: clip.title, startSec: clip.start_sec, endSec: clip.end_sec },
      source: { url: fileUrl(source.storage_key) ?? "", width: source.width ?? 1920, height: source.height ?? 1080, duration: source.duration_sec },
      cropTrack: clip.crop_track,
      getTime: () => (playerRef.current?.getCurrentFrame() ?? playhead.current) / OUT_FPS,
      seekSec: (t) => seekFrame(Math.round(t * OUT_FPS)),
      seekFrame,
      togglePlay: () => playerRef.current?.toggle(),
      saveNow: async () => (await autosaver.current?.flush()) ?? true,
      openTab: setTab,
      showHelp: () => setHelp(true),
    }),
    [store, playhead, view, save, clip.id, clip.project_id, clip.title, clip.start_sec, clip.end_sec, clip.crop_track, source.storage_key, source.width, source.height, source.duration_sec, seekFrame],
  );

  useEditorShortcuts(ctx);

  return (
    <EditorProvider value={ctx}>
      <div className="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-bg text-fg">
        <EditorHeader onExport={() => setTab("export")} />
        {notice ? (
          <div role="status" className="flex items-center justify-between gap-3 border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-xs text-warn">
            <span>{notice}</span>
            <button type="button" className="cursor-pointer font-semibold underline" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1">
          <Preview />
          <Inspector tab={tab} setTab={setTab} words={words} initialRenders={initialRenders} initialJobs={initialJobs} />
        </div>
        <Timeline />
        <ShortcutsDialog open={help} onClose={() => setHelp(false)} />
      </div>
    </EditorProvider>
  );
}
