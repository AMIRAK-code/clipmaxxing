export type ShortcutAction =
  | "playPause"
  | "stepBack"
  | "stepForward"
  | "stepBackSec"
  | "stepForwardSec"
  | "shuttleBack"
  | "shuttlePause"
  | "shuttleForward"
  | "split"
  | "delete"
  | "undo"
  | "redo"
  | "save"
  | "zoomIn"
  | "zoomOut"
  | "home"
  | "end"
  | "help";

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** True when the keyboard event target is a text-entry element (shortcuts must not fire there). */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean; type?: string } | null | undefined): boolean {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = (t.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t.type ?? "text").toLowerCase();
    return !["checkbox", "radio", "button", "range", "color", "file"].includes(type);
  }
  return false;
}

/** Map a key event to an editor action, or null. Does not look at the target; see isTypingTarget. */
export function matchShortcut(e: KeyLike): ShortcutAction | null {
  const mod = Boolean(e.ctrlKey || e.metaKey);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (key === "z") return e.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
    if (key === "s") return "save";
    return null;
  }
  if (e.altKey) return null;
  switch (key) {
    case " ":
    case "Spacebar":
      return "playPause";
    case "ArrowLeft":
      return e.shiftKey ? "stepBackSec" : "stepBack";
    case "ArrowRight":
      return e.shiftKey ? "stepForwardSec" : "stepForward";
    case "j":
      return "shuttleBack";
    case "k":
      return "shuttlePause";
    case "l":
      return "shuttleForward";
    case "s":
      return "split";
    case "Delete":
    case "Backspace":
      return "delete";
    case "+":
    case "=":
      return "zoomIn";
    case "-":
    case "_":
      return "zoomOut";
    case "Home":
      return "home";
    case "End":
      return "end";
    case "?":
      return "help";
    default:
      return null;
  }
}

export const SHORTCUT_HELP: Array<{ keys: string; label: string }> = [
  { keys: "Space", label: "Play / pause" },
  { keys: "← / →", label: "Step one frame (Shift: one second)" },
  { keys: "J / K / L", label: "Reverse (repeat J for faster) / pause / play" },
  { keys: "S", label: "Split the video at the playhead" },
  { keys: "Delete / Backspace", label: "Ripple delete the selected piece (or remove the selected item)" },
  { keys: "Ctrl+Z", label: "Undo" },
  { keys: "Ctrl+Shift+Z / Ctrl+Y", label: "Redo" },
  { keys: "Ctrl+S", label: "Save now" },
  { keys: "+ / -", label: "Zoom the timeline" },
  { keys: "Ctrl + scroll", label: "Zoom the timeline around the cursor" },
  { keys: "Home / End", label: "Jump to start / end" },
  { keys: "?", label: "Show this help" },
];

/** J/K/L shuttle: next playback rate given the current one and the pressed key. */
export function nextShuttleRate(current: number, action: "shuttleBack" | "shuttlePause" | "shuttleForward"): number {
  if (action === "shuttlePause") return 0;
  const dir = action === "shuttleForward" ? 1 : -1;
  if (current === 0 || Math.sign(current) !== dir) return dir;
  return Math.sign(current) * Math.min(4, Math.abs(current) * 2);
}
