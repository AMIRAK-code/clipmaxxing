"use client";

import { OUT_FPS } from "@klipz/shared";
import { useEffect } from "react";
import { isTypingTarget, matchShortcut, nextShuttleRate, targetOwnsKey } from "@/lib/editor/shortcuts";
import { durationFrames, type EditorCtx } from "./editor-context";

export const TIMELINE_ZOOM_EVENT = "klipz:timeline-zoom";

export function useEditorShortcuts(ctx: EditorCtx): void {
  useEffect(() => {
    let shuttleRate = 0;
    let shuttleTimer: ReturnType<typeof setInterval> | null = null;
    const stopShuttle = () => {
      shuttleRate = 0;
      if (shuttleTimer) clearInterval(shuttleTimer);
      shuttleTimer = null;
    };
    const player = () => ctx.playerRef.current;
    const frame = () => player()?.getCurrentFrame() ?? ctx.playhead.current;

    const onKey = (e: KeyboardEvent) => {
      const action = matchShortcut(e);
      if (!action) return;
      const target = e.target as HTMLElement | null;
      if (document.querySelector("dialog[open]") && action !== "help") return;
      // Typing fields keep everything except the save chord; sliders, selects, buttons, tabs ... keep the keys they use themselves.
      if (target && isTypingTarget(target) && action !== "save") return;
      if (target && !(e.ctrlKey || e.metaKey)) {
        const own = targetOwnsKey({ tagName: target.tagName, isContentEditable: target.isContentEditable, type: (target as HTMLInputElement).type, role: target.getAttribute?.("role") }, e.key);
        if (own) return;
      }
      e.preventDefault();

      const edit = ctx.store.getState().edit;
      const last = durationFrames(edit) - 1;
      const step = (d: number) => {
        stopShuttle();
        player()?.pause();
        ctx.seekFrame(Math.min(last, Math.max(0, frame() + d)));
      };
      switch (action) {
        case "playPause":
          stopShuttle();
          ctx.togglePlay();
          break;
        case "stepBack":
          step(-1);
          break;
        case "stepForward":
          step(1);
          break;
        case "stepBackSec":
          step(-OUT_FPS);
          break;
        case "stepForwardSec":
          step(OUT_FPS);
          break;
        case "shuttleForward":
          stopShuttle();
          player()?.play();
          break;
        case "shuttlePause":
          stopShuttle();
          player()?.pause();
          break;
        case "shuttleBack": {
          player()?.pause();
          shuttleRate = nextShuttleRate(shuttleRate > 0 ? 0 : shuttleRate, "shuttleBack");
          if (shuttleTimer) clearInterval(shuttleTimer);
          shuttleTimer = setInterval(() => {
            const next = frame() + shuttleRate; // shuttleRate is negative
            if (next <= 0) {
              ctx.seekFrame(0);
              stopShuttle();
            } else ctx.seekFrame(next);
          }, 1000 / OUT_FPS);
          break;
        }
        case "split":
          ctx.store.getState().splitAt(ctx.getTime());
          break;
        case "delete":
          ctx.store.getState().deleteSelection();
          break;
        case "undo":
          ctx.store.getState().undo();
          break;
        case "redo":
          ctx.store.getState().redo();
          break;
        case "save":
          void ctx.saveNow();
          break;
        case "zoomIn":
          window.dispatchEvent(new CustomEvent(TIMELINE_ZOOM_EVENT, { detail: { factor: 1.5 } }));
          break;
        case "zoomOut":
          window.dispatchEvent(new CustomEvent(TIMELINE_ZOOM_EVENT, { detail: { factor: 1 / 1.5 } }));
          break;
        case "home":
          step(-1e9);
          break;
        case "end":
          step(1e9);
          break;
        case "help":
          ctx.showHelp();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stopShuttle();
    };
  }, [ctx]);
}
