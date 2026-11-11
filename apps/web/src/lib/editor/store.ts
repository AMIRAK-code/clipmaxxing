import { createStore, type StoreApi } from "zustand/vanilla";
import { uid, type AudioItem, type BrollItem, type EditState, type TextItem, type ZoomKey } from "@klipz/shared";
import { canRedo, canUndo, commit, createHistory, redo as redoH, undo as undoH, type History } from "./history";
import * as ops from "./ops";
import type { Recipe } from "./ops";

export type Selection =
  | { kind: "piece"; id: string }
  | { kind: "zoom"; id: string }
  | { kind: "broll"; id: string }
  | { kind: "audio"; id: string }
  | { kind: "text"; id: string }
  | { kind: "word"; id: string }
  | null;

export interface EditorState {
  history: History<EditState>;
  /** current edit (history.present) – a stable reference between changes */
  edit: EditState;
  /** bumped on every change to `edit` (including undo/redo); autosave watches it */
  rev: number;
  canUndo: boolean;
  canRedo: boolean;
  selection: Selection;
}

export interface EditorActions {
  /** Run an arbitrary recipe as one undo step. `key` coalesces rapid changes of the same control. */
  apply(recipe: Recipe, key?: string): void;
  undo(): void;
  redo(): void;
  /** Replace the whole edit and forget history (initial load, server conflict). */
  reset(edit: EditState): void;
  select(sel: Selection): void;

  splitAt(tOut: number): void;
  rippleDeletePiece(id: string): void;
  trimPiece(id: string, edge: "start" | "end", newSrc: number, bounds: { min: number; max: number }): void;
  addZoom(tOut: number, scale?: number): string;
  addBroll(args: { src: string; kind: BrollItem["kind"]; start: number; duration: number; duck?: boolean; fit?: BrollItem["fit"] }): string;
  addAudio(args: { src: string; kind?: AudioItem["kind"]; start: number; duration: number }): string;
  addText(args: { start: number; text?: string }): string;
  /** Delete whatever the current selection is (ripple delete for video pieces). */
  deleteSelection(): boolean;
}

export type EditorStore = StoreApi<EditorState & EditorActions>;

export function createEditorStore(initial: EditState, now: () => number = Date.now): EditorStore {
  return createStore<EditorState & EditorActions>()((set, get) => {
    const write = (history: History<EditState>, selection?: Selection) =>
      set((s) => ({
        history,
        edit: history.present,
        rev: s.rev + 1,
        canUndo: canUndo(history),
        canRedo: canRedo(history),
        ...(selection !== undefined ? { selection } : {}),
      }));
    const apply: EditorActions["apply"] = (recipe, key) => {
      const next = commit(get().history, recipe, { key, now: now() });
      if (next !== get().history) write(next);
    };
    return {
      history: createHistory(initial),
      edit: initial,
      rev: 0,
      canUndo: false,
      canRedo: false,
      selection: null,
      apply,
      undo: () => {
        const h = undoH(get().history);
        if (h !== get().history) write(h, validSelection(get().selection, h.present));
      },
      redo: () => {
        const h = redoH(get().history);
        if (h !== get().history) write(h, validSelection(get().selection, h.present));
      },
      reset: (edit) => write(createHistory(edit), null),
      select: (selection) => set({ selection }),

      splitAt: (t) => apply(ops.splitAtTime(t)),
      rippleDeletePiece: (id) => {
        apply(ops.rippleDeletePiece(id));
        if (get().selection?.id === id) set({ selection: null });
      },
      trimPiece: (id, edge, newSrc, bounds) => apply(ops.trimPieceEdge(id, edge, newSrc, bounds), `trim:${id}:${edge}`),
      addZoom: (t, scale = 1.3) => {
        const key: ZoomKey = { id: uid("z"), t: Math.max(0, t), scale, ease: "ease" };
        apply(ops.addZoomKey(key));
        set({ selection: { kind: "zoom", id: key.id } });
        return key.id;
      },
      addBroll: (a) => {
        const item: BrollItem = {
          id: uid("b"),
          src: a.src,
          kind: a.kind,
          start: Math.max(0, a.start),
          duration: Math.max(ops.MIN_ITEM_SEC, a.duration),
          srcOffset: 0,
          volume: 1,
          duck: a.duck ?? true,
          fit: a.fit ?? "cover",
        };
        apply(ops.addBroll(item));
        set({ selection: { kind: "broll", id: item.id } });
        return item.id;
      },
      addAudio: (a) => {
        const item: AudioItem = {
          id: uid("a"),
          src: a.src,
          kind: a.kind ?? "music",
          start: Math.max(0, a.start),
          duration: Math.max(ops.MIN_ITEM_SEC, a.duration),
          srcOffset: 0,
          volume: a.kind === "voiceover" ? 1 : 0.5,
          duck: a.kind === "voiceover",
        };
        apply(ops.addAudio(item));
        set({ selection: { kind: "audio", id: item.id } });
        return item.id;
      },
      addText: (a) => {
        const item: TextItem = {
          id: uid("t"),
          text: a.text ?? "Your text",
          start: Math.max(0, a.start),
          duration: 3,
          x: 0.5,
          y: 0.35,
          fontFamily: "Montserrat",
          fontSize: 72,
          fontWeight: 900,
          color: "#FFFFFF",
          background: "transparent",
          anim: "pop",
        };
        apply(ops.addText(item));
        set({ selection: { kind: "text", id: item.id } });
        return item.id;
      },
      deleteSelection: () => {
        const sel = get().selection;
        if (!sel) return false;
        switch (sel.kind) {
          case "piece":
            if (get().edit.video.length <= 1) return false;
            apply(ops.rippleDeletePiece(sel.id));
            break;
          case "zoom":
            apply(ops.removeZoomKey(sel.id));
            break;
          case "broll":
            apply(ops.removeBroll(sel.id));
            break;
          case "audio":
            apply(ops.removeAudio(sel.id));
            break;
          case "text":
            apply(ops.removeText(sel.id));
            break;
          case "word":
            apply(ops.toggleWordHidden(sel.id));
            return true;
        }
        set({ selection: null });
        return true;
      },
    };
  });
}

/** Drop a selection whose target no longer exists after undo/redo. */
export function validSelection(sel: Selection, edit: EditState): Selection {
  if (!sel) return null;
  const lists: Record<string, { id: string }[]> = {
    piece: edit.video,
    zoom: edit.zooms,
    broll: edit.broll,
    audio: edit.audio,
    text: edit.texts,
    word: edit.captions.words,
  };
  return lists[sel.kind]?.some((x) => x.id === sel.id) ? sel : null;
}
