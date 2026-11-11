export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Index to focus next when Tab / Shift+Tab is pressed inside a dialog with `count` focusable elements. -1 = let the browser handle it. */
export function trapTarget(count: number, activeIndex: number, shift: boolean): number {
  if (count === 0) return -2; // nothing focusable: keep focus where it is
  if (activeIndex === -1) return shift ? count - 1 : 0; // focus is outside the dialog
  if (!shift && activeIndex === count - 1) return 0;
  if (shift && activeIndex === 0) return count - 1;
  return -1;
}
