"""Python port of the composition math the Remotion renderer uses (packages/shared/src/*.ts and
packages/video/src/anim.ts). The fast renderer must make the same per-frame decisions as the React
components, so these functions mirror the TypeScript line by line. Keep them in sync when the TS changes;
tests/test_fastrender.py checks the shared presets file and a set of known values.

All times are seconds; frames are output frames at OUT_FPS.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence

OUT_W, OUT_H, OUT_FPS = 1080, 1920, 30

_PRESETS = json.loads((Path(__file__).with_name("presets.json")).read_text(encoding="utf-8"))
CAPTION_PRESETS: list[dict[str, Any]] = _PRESETS["captionPresets"]
SAFE_ZONES: dict[str, dict[str, float]] = _PRESETS["safeZones"]
FONT_FILES: dict[str, list[dict[str, Any]]] = _PRESETS["fontFiles"]


def js_round(x: float) -> int:
    """Math.round: halves go up (Python's round() goes to even)."""
    return int(math.floor(x + 0.5))


def clamp01(x: float) -> float:
    return min(1.0, max(0.0, x))


# ── pieces ────────────────────────────────────────────────────────────────
def piece_duration(p: dict[str, Any]) -> float:
    return max(0.0, float(p["srcEnd"]) - float(p["srcStart"]))


def piece_offsets(pieces: Sequence[dict[str, Any]]) -> list[float]:
    out, acc = [], 0.0
    for p in pieces:
        out.append(acc)
        acc += piece_duration(p)
    return out


def total_duration(pieces: Sequence[dict[str, Any]]) -> float:
    return sum(piece_duration(p) for p in pieces)


def piece_frames(pieces: Sequence[dict[str, Any]], fps: int = OUT_FPS) -> list[tuple[int, int]]:
    """(from, duration) in output frames per piece; cumulative rounding so pieces tile exactly."""
    offs = piece_offsets(pieces)
    out = []
    for p, o in zip(pieces, offs):
        start = js_round(o * fps)
        end = js_round((o + piece_duration(p)) * fps)
        out.append((start, max(1, end - start)))
    return out


def duration_in_frames(pieces: Sequence[dict[str, Any]], fps: int = OUT_FPS) -> int:
    return max(1, js_round(total_duration(pieces) * fps))


# ── zoom ──────────────────────────────────────────────────────────────────
def zoom_at(zooms: Sequence[dict[str, Any]], t: float) -> float:
    if not zooms:
        return 1.0
    keys = sorted(zooms, key=lambda k: k["t"])
    if t <= keys[0]["t"]:
        return float(keys[0]["scale"])
    for a, b in zip(keys, keys[1:]):
        if a["t"] <= t <= b["t"]:
            if b.get("ease") == "snap":
                return float(a["scale"])
            k = (t - a["t"]) / max(1e-6, b["t"] - a["t"])
            if b.get("ease") == "ease":
                k = k * k * (3 - 2 * k)
            return a["scale"] + (b["scale"] - a["scale"]) * k
    return float(keys[-1]["scale"])


# ── crop track ────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    w: float
    h: float


@dataclass(frozen=True)
class Pane:
    dst: Rect
    src: Rect


@dataclass(frozen=True)
class FrameLayout:
    layout: str  # crop | split | letterbox
    panes: tuple[Pane, ...]
    blurred_background: bool


def segment_at(track: dict[str, Any], t: float) -> Optional[dict[str, Any]]:
    segs = track.get("segments") or []
    for s in segs:
        if s["start"] <= t < s["end"]:
            return s
    best, best_d = None, math.inf
    for s in segs:
        d = s["start"] - t if t < s["start"] else t - s["end"]
        if d < best_d:
            best, best_d = s, d
    return best


def interpolate_keys(keys: Sequence[dict[str, Any]], t: float) -> tuple[float, float]:
    if not keys:
        return 0.5, 0.5
    first = keys[0]
    if t <= first["t"]:
        return first["cx"], first["cy"]
    lo, hi = 0, len(keys) - 1
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if keys[mid]["t"] <= t:
            lo = mid
        else:
            hi = mid
    a, b = keys[lo], keys[hi]
    if t >= b["t"]:
        return b["cx"], b["cy"]
    k = (t - a["t"]) / max(1e-6, b["t"] - a["t"])
    return a["cx"] + (b["cx"] - a["cx"]) * k, a["cy"] + (b["cy"] - a["cy"]) * k


MAX_FRAME_ZOOM = 4.0


def window_around(src_w: float, src_h: float, aspect: float, cx: float, cy: float, zoom: float = 1.0) -> Rect:
    w, h = src_w, src_w / aspect
    if h > src_h:
        h, w = src_h, src_h * aspect
    w, h = w / zoom, h / zoom
    x = min(max(cx * src_w - w / 2, 0), src_w - w)
    y = min(max(cy * src_h - h / 2, 0), src_h - h)
    return Rect(x, y, w, h)


def layout_at(track: Optional[dict[str, Any]], t: float, src_w: int, src_h: int, out_w: int = OUT_W, out_h: int = OUT_H) -> FrameLayout:
    seg = segment_at(track, t) if track else None
    out_aspect = out_w / out_h
    if not seg:
        return FrameLayout("crop", (Pane(Rect(0, 0, out_w, out_h), window_around(src_w, src_h, out_aspect, 0.5, 0.5)),), False)
    if seg["layout"] == "split":
        half = out_h / 2
        ax, ay = interpolate_keys(seg["keys"], t)
        bx, by = interpolate_keys(seg.get("keys2") or seg["keys"], t)
        aspect = out_w / half
        return FrameLayout("split", (
            Pane(Rect(0, 0, out_w, half), window_around(src_w, src_h, aspect, ax, ay)),
            Pane(Rect(0, half, out_w, half), window_around(src_w, src_h, aspect, bx, by)),
        ), False)
    if seg["layout"] == "letterbox":
        h = min(out_h, (out_w * src_h) / src_w)
        return FrameLayout("letterbox", (Pane(Rect(0, (out_h - h) / 2, out_w, h), Rect(0, 0, src_w, src_h)),), True)
    cx, cy = interpolate_keys(seg["keys"], t)
    zoom = min(MAX_FRAME_ZOOM, max(1.0, float(seg.get("zoom") or 1.0)))
    return FrameLayout("crop", (Pane(Rect(0, 0, out_w, out_h), window_around(src_w, src_h, out_aspect, cx, cy, zoom)),), False)


def manual_crop_track(frame: dict[str, Any], src_w: int, src_h: int) -> dict[str, Any]:
    """crop.ts manualCropTrack(): the frame set by hand in the editor as a one-segment track."""
    def c01(v: Any) -> float:
        try:
            x = float(v)
        except (TypeError, ValueError):
            return 0.5
        return min(1.0, max(0.0, x)) if x == x else 0.5

    try:
        zoom = float(frame.get("zoom") or 1.0)
    except (TypeError, ValueError):
        zoom = 1.0
    layout = "letterbox" if frame.get("layout") == "letterbox" else "crop"
    return {"version": 1, "srcW": src_w, "srcH": src_h, "segments": [{
        "start": 0, "end": 9007199254740991, "layout": layout, "keys": [{"t": 0, "cx": c01(frame.get("cx")), "cy": c01(frame.get("cy"))}],
        "zoom": min(MAX_FRAME_ZOOM, max(1.0, zoom if zoom == zoom else 1.0)),
    }]}


def effective_crop_track(edit: dict[str, Any], track: Optional[dict[str, Any]], src_w: int, src_h: int) -> Optional[dict[str, Any]]:
    frame = edit.get("frame")
    return manual_crop_track(frame, src_w, src_h) if isinstance(frame, dict) else track


# ── captions ──────────────────────────────────────────────────────────────
def resolve_caption_style(style_id: str, overrides: Optional[dict[str, Any]] = None, custom: Sequence[dict[str, Any]] = ()) -> dict[str, Any]:
    found = next((s for s in custom if s.get("id") == style_id), None) or next(
        (s for s in CAPTION_PRESETS if s["id"] == style_id), None) or CAPTION_PRESETS[0]
    return {**found, **(overrides or {})}


def caption_words_on_timeline(pieces: Sequence[dict[str, Any]], words: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Words that fall inside a piece, with output times `os` / `oe`."""
    offs = piece_offsets(pieces)
    out: list[dict[str, Any]] = []
    for p, off in zip(pieces, offs):
        for w in words:
            if w.get("hidden"):
                continue
            mid = (w["s"] + w["e"]) / 2
            if mid < p["srcStart"] or mid >= p["srcEnd"]:
                continue
            os_ = off + max(0.0, w["s"] - p["srcStart"])
            oe = off + min(piece_duration(p), w["e"] - p["srcStart"])
            out.append({**w, "os": os_, "oe": max(oe, os_ + 0.04)})
    out.sort(key=lambda w: w["os"])
    return out


_SENTENCE_END = re.compile(r"[.!?…][\"')\]]?$")


def _js_len(s: str) -> int:
    """String.length (UTF-16 code units), which is what the TS layout counts."""
    return len(s.encode("utf-16-le")) // 2


@dataclass
class CaptionPage:
    start: float
    end: float
    words: list[dict[str, Any]]


def paginate(words: Sequence[dict[str, Any]], style: dict[str, Any], max_gap: float = 0.6) -> list[CaptionPage]:
    pages: list[CaptionPage] = []
    cur: list[dict[str, Any]] = []

    def flush() -> None:
        nonlocal cur
        if cur:
            pages.append(CaptionPage(cur[0]["os"], cur[-1]["oe"], cur))
            cur = []

    for w in words:
        if cur:
            prev = cur[-1]
            chars = sum(_js_len(x["w"]) + 1 for x in cur) + _js_len(w["w"])
            full = len(cur) >= style["wordsPerPage"]
            too_long = chars > style["maxCharsPerLine"] * 2
            pause = w["os"] - prev["oe"] > max_gap
            if full or too_long or pause or _SENTENCE_END.search(prev["w"]):
                flush()
        cur.append(w)
    flush()
    for i, p in enumerate(pages):
        nxt = pages[i + 1] if i + 1 < len(pages) else None
        hold = min(nxt.start, p.end + max_gap) if nxt else p.end + 0.3
        p.end = max(p.end, hold)
    return pages


def page_at(pages: Sequence[CaptionPage], t: float) -> Optional[int]:
    lo, hi = 0, len(pages) - 1
    while lo <= hi:
        mid = (lo + hi) >> 1
        p = pages[mid]
        if t < p.start:
            hi = mid - 1
        elif t >= p.end:
            lo = mid + 1
        else:
            return mid
    return None


def active_word_index(page: CaptionPage, t: float) -> int:
    idx = -1
    for i, w in enumerate(page.words):
        if t >= w["os"]:
            idx = i
    return idx


def layout_lines(words: Sequence[dict[str, Any]], max_chars: int) -> list[list[dict[str, Any]]]:
    lines: list[list[dict[str, Any]]] = []
    line: list[dict[str, Any]] = []
    length = 0
    for w in words:
        add = (1 if line else 0) + _js_len(w["w"])
        if line and length + add > max_chars:
            lines.append(line)
            line, length = [], 0
        line.append(w)
        length += (1 if len(line) > 1 else 0) + _js_len(w["w"])
    if line:
        lines.append(line)
    return lines


def clamp_to_safe_zone(position: float, zone: Optional[dict[str, float]], block_frac: float = 0.12) -> float:
    if not zone:
        return position
    lo = zone["top"] + block_frac / 2
    hi = 1 - zone["bottom"] - block_frac / 2
    return min(max(position, lo), hi)


SIDE_MARGIN = 48


def max_caption_width(safe_zone: str) -> float:
    if safe_zone == "none" or safe_zone not in SAFE_ZONES:
        return OUT_W - SIDE_MARGIN * 2
    z = SAFE_ZONES[safe_zone]
    side = max(SIDE_MARGIN, max(z["left"], z["right"]) * OUT_W)
    return OUT_W - side * 2


# ── animation curves (remotion Easing / spring) ───────────────────────────
def _ease_out(fn: Any, t: float) -> float:
    return 1 - fn(1 - t)


def _back(s: float) -> Any:
    return lambda t: t * t * ((s + 1) * t - s)


def _cubic(t: float) -> float:
    return t * t * t


def spring(frame: float, fps: int, damping: float, stiffness: float, mass: float) -> float:
    """remotion spring() from 0 to 1 (under-damped closed form; each step in remotion is the exact solution)."""
    f = max(0.0, frame)
    t = f / fps
    zeta = damping / (2 * math.sqrt(stiffness * mass))
    omega0 = math.sqrt(stiffness / mass)
    if zeta < 1:
        omega1 = omega0 * math.sqrt(1 - zeta * zeta)
        env = math.exp(-zeta * omega0 * t)
        return 1 - env * (math.cos(omega1 * t) + (zeta * omega0 / omega1) * math.sin(omega1 * t))
    env = math.exp(-omega0 * t)
    return 1 - env * (1 + omega0 * t)


@dataclass(frozen=True)
class Entrance:
    opacity: float
    scale: float
    translate_y: float


def entrance(anim: str, frame: int, fps: int = OUT_FPS) -> Entrance:
    f = max(0, frame)
    if anim == "pop":
        d = max(1, js_round(fps * 0.2))
        k = clamp01(f / d)
        return Entrance(clamp01(f / max(1, d / 2)), 0.6 + 0.4 * _ease_out(_back(2.2), k), 0.0)
    if anim == "bounce":
        s = spring(f, fps, 9, 220, 0.7)
        return Entrance(clamp01(f / 2), 0.4 + 0.6 * s, (1 - s) * 40)
    if anim == "fade":
        d = max(1, js_round(fps * 0.2))
        return Entrance(clamp01(f / d), 1.0, 0.0)
    if anim == "slide-up":
        d = max(1, js_round(fps * 0.25))
        k = _ease_out(_cubic, clamp01(f / d))
        return Entrance(clamp01(f / max(1, d / 2)), 1.0, (1 - k) * 70)
    return Entrance(1.0, 1.0, 0.0)


def settle_frame(anim: str, fps: int = OUT_FPS) -> int:
    """Frames after which entrance(anim, f) no longer changes, so later frames can share one state."""
    if anim in ("pop", "fade"):
        return max(1, js_round(fps * 0.2))
    if anim == "slide-up":
        return max(1, js_round(fps * 0.25))
    if anim == "bounce":
        return js_round(fps * 4 / 3)  # the spring is within 2e-4 of rest after 1.33 s
    return 0


def hook_envelope(frame: int, duration_frames: int, fps: int = OUT_FPS) -> float:
    edge = min(js_round(fps * 0.3), duration_frames // 2)
    if edge <= 0:
        return 1.0
    return min(clamp01(frame / edge), clamp01((duration_frames - frame) / edge))
