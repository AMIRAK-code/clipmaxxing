"use client";

import type { PlayerRef } from "@remotion/player";
import { OUT_FPS, totalDuration, type CropTrack, type EditState } from "@klipz/shared";
import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { Autosaver, SaveInfo } from "@/lib/editor/autosave";
import type { Playhead } from "@/lib/editor/playhead";
import { clampFrame } from "@/lib/editor/timeline-math";
import type { EditorActions, EditorState, EditorStore } from "@/lib/editor/store";

export interface ClipMeta {
  id: string;
  projectId: string;
  title: string | null;
  startSec: number;
  endSec: number;
}

export interface SourceMeta {
  url: string;
  width: number;
  height: number;
  duration: number | null;
}

export interface TimelineView {
  pps: number;
  scrollLeft: number;
  viewportWidth: number;
  loop: boolean;
  playing: boolean;
  showSafeZone: boolean;
}

export interface SaveState extends SaveInfo {
  /** bump to re-render the status pill */
  at: number;
}

export interface EditorCtx {
  store: EditorStore;
  playhead: Playhead;
  playerRef: { current: PlayerRef | null };
  autosaver: { current: Autosaver | null };
  view: StoreApi<TimelineView>;
  save: StoreApi<SaveState>;
  clip: ClipMeta;
  source: SourceMeta;
  cropTrack: CropTrack | null;
  /** current playhead in output seconds */
  getTime(): number;
  seekSec(t: number): void;
  seekFrame(f: number): void;
  togglePlay(): void;
  saveNow(): Promise<boolean>;
  /** ids of render jobs etc. live in the export panel; this opens it */
  openTab(tab: InspectorTab): void;
  showHelp(): void;
}

export type InspectorTab = "captions" | "video" | "media" | "text" | "overlays" | "export";

const Ctx = createContext<EditorCtx | null>(null);
export const EditorProvider = Ctx.Provider;

export function useEditorCtx(): EditorCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("EditorProvider missing");
  return c;
}

/** Subscribe to a slice of the editor store. */
export function useEditor<T>(selector: (s: EditorState & EditorActions) => T): T {
  return useStore(useEditorCtx().store, selector);
}
export const useEdit = (): EditState => useEditor((s) => s.edit);

export function useView<T>(selector: (v: TimelineView) => T): T {
  return useStore(useEditorCtx().view, selector);
}
export function useSaveState(): SaveState {
  return useStore(useEditorCtx().save, (s) => s);
}

export const createViewStore = (): StoreApi<TimelineView> => createStore<TimelineView>(() => ({ pps: 40, scrollLeft: 0, viewportWidth: 800, loop: true, playing: false, showSafeZone: false }));
export const createSaveStore = (): StoreApi<SaveState> => createStore<SaveState>(() => ({ status: "saved", at: 0 }));

export const durationFrames = (edit: Pick<EditState, "video">): number => Math.max(1, Math.round(totalDuration(edit.video) * OUT_FPS));
export const clampToDuration = (edit: Pick<EditState, "video">, frame: number): number => clampFrame(frame, durationFrames(edit));
