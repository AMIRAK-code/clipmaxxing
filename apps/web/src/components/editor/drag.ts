import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Start a pointer drag from a React pointerdown. Listens on `window` so the
 * drag keeps working when the pointer leaves the element. `onMove` receives the
 * total pixel offset since the press.
 */
export function startDrag(
  e: ReactPointerEvent,
  onMove: (dx: number, dy: number, ev: PointerEvent) => void,
  onEnd?: (moved: boolean) => void,
): void {
  if (e.button !== 0) return;
  e.stopPropagation();
  const x0 = e.clientX;
  const y0 = e.clientY;
  let moved = false;
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - x0;
    const dy = ev.clientY - y0;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    moved = true;
    onMove(dx, dy, ev);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onEnd?.(moved);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
