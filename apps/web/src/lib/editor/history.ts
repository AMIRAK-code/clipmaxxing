import { applyPatches, enablePatches, produceWithPatches, type Draft, type Patch } from "immer";

enablePatches();

/** One undo step: the forward patches and the patches that revert them. */
export interface HistoryEntry {
  patches: Patch[];
  inverse: Patch[];
  /** changes with the same key within `coalesceMs` merge into one entry (drags, typing) */
  key?: string;
  at: number;
}

export interface History<T> {
  present: T;
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const HISTORY_CAP = 200;
export const COALESCE_MS = 700;

export const createHistory = <T>(present: T): History<T> => ({ present, past: [], future: [] });

export interface CommitOptions {
  key?: string;
  now?: number;
  coalesceMs?: number;
  cap?: number;
}

/**
 * Apply a recipe. No-op recipes (no patches) leave the history untouched.
 * A new change always clears the redo stack.
 */
export function commit<T extends object>(h: History<T>, recipe: (draft: Draft<T>) => void, opts: CommitOptions = {}): History<T> {
  const [next, patches, inverse] = produceWithPatches(h.present, recipe);
  if (patches.length === 0) return h;
  const now = opts.now ?? Date.now();
  const window = opts.coalesceMs ?? COALESCE_MS;
  const cap = opts.cap ?? HISTORY_CAP;
  const last = h.past[h.past.length - 1];
  let past: HistoryEntry[];
  if (opts.key && last && last.key === opts.key && now - last.at <= window && h.future.length === 0) {
    // Newer inverse patches must run first when undoing the merged step.
    const merged: HistoryEntry = { patches: [...last.patches, ...patches], inverse: [...inverse, ...last.inverse], key: opts.key, at: now };
    past = [...h.past.slice(0, -1), merged];
  } else {
    past = [...h.past, { patches, inverse, key: opts.key, at: now }];
    if (past.length > cap) past = past.slice(past.length - cap);
  }
  return { present: next as T, past, future: [] };
}

export function undo<T extends object>(h: History<T>): History<T> {
  const entry = h.past[h.past.length - 1];
  if (!entry) return h;
  return {
    present: applyPatches(h.present, entry.inverse),
    past: h.past.slice(0, -1),
    // `at: -Infinity` so a later edit never merges into something that was undone
    future: [{ ...entry, at: Number.NEGATIVE_INFINITY }, ...h.future],
  };
}

export function redo<T extends object>(h: History<T>): History<T> {
  const entry = h.future[0];
  if (!entry) return h;
  return { present: applyPatches(h.present, entry.patches), past: [...h.past, { ...entry, at: Number.NEGATIVE_INFINITY }], future: h.future.slice(1) };
}

export const canUndo = (h: History<unknown>): boolean => h.past.length > 0;
export const canRedo = (h: History<unknown>): boolean => h.future.length > 0;
