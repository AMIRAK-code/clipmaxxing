"use client";

import { useEffect, type RefObject } from "react";
import { FOCUSABLE, trapTarget } from "@/lib/focus-trap";

/**
 * Modal behaviour for a dialog container: Tab / Shift+Tab stay inside it and focus returns to the
 * element that opened it when it closes. (Escape handling stays with each dialog.)
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, open: boolean): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = ref.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      const idx = items.indexOf(document.activeElement as HTMLElement);
      const next = trapTarget(items.length, idx, e.shiftKey);
      if (next === -1) return;
      e.preventDefault();
      if (next >= 0) items[next]!.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [ref, open]);
}
