"""Smart Edit: the built-in automatic editor. No AI model needed.

Given a clip's word timings it produces a ready EditState (the same JSON the browser editor saves), doing
what a short-form editor does by hand:

  * jump cuts: dead air between words and isolated filler words ("um", "uh") are cut out,
  * punch-ins: the framing alternates slightly on every cut (hides the jump) and snaps in on emphasised words,
  * captions: word-timed, with the clip's keywords emphasised,
  * hook card over the first seconds, progress bar along the bottom.

Everything stays editable afterwards. Pure functions over plain data so it is easy to test.
"""
from __future__ import annotations

import re
from typing import Any, Optional, Sequence

from . import heuristics as H

# ── tuning ────────────────────────────────────────────────────────────────
MAX_GAP = 0.45          # silence longer than this between two words is cut ...
KEEP_PAD = 0.12         # ... keeping this much air on each side so speech is never clipped
MIN_PIECE = 0.35        # never leave a sliver shorter than this
FILLER_WORDS = {"um", "uh", "uhm", "umm", "er", "erm", "hmm", "mm", "ah"}
FILLER_MIN_GAP = 0.08   # a filler is only cut when there is a little silence on both sides (clean cut)
CUT_ZOOM = 1.07         # alternate framing on jump cuts
PUNCH_ZOOM = 1.16       # emphasis punch-in
PUNCH_HOLD = 1.1
PUNCH_EVERY = 3.5       # at most one emphasis punch per this many seconds
HOOK_SECONDS = 3.0
DEFAULT_STYLE = "bold-outline"

_CLEAN_RE = re.compile(r"[^\w']", re.UNICODE)


def _norm(w: str) -> str:
    return _CLEAN_RE.sub("", w).lower()


def _r(x: float) -> float:
    return round(x, 3)


def keep_ranges(words: Sequence[dict[str, Any]], start: float, end: float) -> list[tuple[float, float]]:
    """Source-time ranges to keep: the clip minus long silences and isolated filler words."""
    ws = [w for w in words if w["e"] > start and w["s"] < end]
    if not ws:
        return [(start, end)]
    spoken: list[tuple[float, float]] = []
    for i, w in enumerate(ws):
        if _norm(str(w["w"])) in FILLER_WORDS:
            before = w["s"] - (ws[i - 1]["e"] if i > 0 else start)
            after = (ws[i + 1]["s"] if i + 1 < len(ws) else end) - w["e"]
            if before >= FILLER_MIN_GAP and after >= FILLER_MIN_GAP:
                continue  # drop it: the gap it leaves is closed below
        spoken.append((max(start, float(w["s"])), min(end, float(w["e"]))))
    if not spoken:
        return [(start, end)]
    ranges: list[list[float]] = []
    for s, e in spoken:
        if ranges and s - ranges[-1][1] <= MAX_GAP:
            ranges[-1][1] = max(ranges[-1][1], e)
        else:
            ranges.append([s, e])
    out: list[tuple[float, float]] = []
    for i, (s, e) in enumerate(ranges):
        lo = max(start, s - KEEP_PAD)
        hi = min(end, e + KEEP_PAD)
        if out and lo <= out[-1][1]:  # pads touch: merge
            out[-1] = (out[-1][0], hi)
        else:
            out.append((lo, hi))
    # absorb slivers into a neighbour rather than flashing a few frames
    merged: list[tuple[float, float]] = []
    for s, e in out:
        if merged and (e - s < MIN_PIECE or merged[-1][1] - merged[-1][0] < MIN_PIECE):
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return merged or [(start, end)]


def _src_to_out(ranges: Sequence[tuple[float, float]], t: float) -> Optional[float]:
    acc = 0.0
    for s, e in ranges:
        if s <= t <= e:
            return acc + (t - s)
        acc += e - s
    return None


def _emphasis(ws: Sequence[dict[str, Any]], keywords: Sequence[str]) -> set[int]:
    keys = {_norm(k) for k in keywords if k}
    if not keys:
        keys = {_norm(k) for k in H.extract_keywords(" ".join(str(w["w"]) for w in ws), 6)}
    out = {i for i, w in enumerate(ws) if _norm(str(w["w"])) in keys}
    # numbers and shouted words always land
    for i, w in enumerate(ws):
        raw = str(w["w"]).strip()
        if re.search(r"\d", raw) or (len(raw) >= 4 and raw.isupper()):
            out.add(i)
    return out


def build_zooms(ranges: Sequence[tuple[float, float]], punch_times: Sequence[float]) -> list[dict[str, Any]]:
    """Zoom keyframes on the output timeline. `snap` holds the previous scale until the key, then jumps."""
    total = sum(e - s for s, e in ranges)
    # base framing per piece: alternate 1.0 / CUT_ZOOM on every jump cut
    bases: list[tuple[float, float, float]] = []  # (out_start, out_end, scale)
    acc = 0.0
    for i, (s, e) in enumerate(ranges):
        bases.append((acc, acc + (e - s), CUT_ZOOM if i % 2 else 1.0))
        acc += e - s

    def base_at(t: float) -> float:
        for a, b, sc in bases:
            if a <= t < b:
                return sc
        return bases[-1][2]

    events: list[tuple[float, float, str]] = [(0.0, 1.0, "linear")]
    for a, _b, sc in bases[1:]:
        events.append((a, sc, "snap"))
    last = -1e9
    for t in sorted(punch_times):
        if t < 0.6 or t > total - 0.5 or t - last < PUNCH_EVERY:
            continue
        end = min(total - 0.05, t + PUNCH_HOLD)
        # do not straddle a cut: the cut's own snap would fight the punch
        if any(t < a <= end for a, _b, _s in bases[1:]):
            continue
        last = t
        events.append((t, PUNCH_ZOOM, "snap"))
        events.append((end, base_at(end), "ease"))
    events.sort(key=lambda ev: ev[0])
    keys: list[dict[str, Any]] = []
    for i, (t, scale, ease) in enumerate(events):
        if keys and abs(keys[-1]["t"] - t) < 0.02:
            keys[-1].update({"scale": _r(scale), "ease": ease})
            continue
        keys.append({"id": f"z{i}_{int(round(t * 1000))}", "t": _r(t), "scale": _r(scale), "ease": ease})
    # a lone "scale 1 at t=0" key means no zoom at all
    return keys if len(keys) > 1 else []


def build_edit(
    words: Sequence[dict[str, Any]],
    start: float,
    end: float,
    *,
    keywords: Sequence[str] = (),
    hook: Optional[str] = None,
    style_id: Optional[str] = None,
) -> dict[str, Any]:
    """A complete EditState (packages/shared/src/types.ts) for the clip [start, end] of the source."""
    start, end = float(start), float(end)
    ws = [w for w in words if w["e"] > start and w["s"] < end and str(w["w"]).strip()]
    ranges = keep_ranges(ws, start, end)
    emph = _emphasis(ws, keywords)

    caption_words: list[dict[str, Any]] = []
    punch_times: list[float] = []
    for i, w in enumerate(ws):
        cw: dict[str, Any] = {"id": f"w{i}_{int(round(float(w['s']) * 1000))}", "w": str(w["w"]).strip(), "s": float(w["s"]), "e": float(w["e"])}
        if w.get("spk"):
            cw["spk"] = w["spk"]
        if i in emph:
            cw["emph"] = True
            t = _src_to_out(ranges, float(w["s"]))
            if t is not None:
                punch_times.append(t)
        caption_words.append(cw)

    video = [
        {"id": f"v{i}_{int(round(s * 1000))}", "srcStart": _r(s), "srcEnd": _r(e)}
        for i, (s, e) in enumerate(ranges)
    ]
    hook_text = (hook or "").strip()
    total = sum(e - s for s, e in ranges)
    return {
        "version": 1,
        # Marks an edit made by Smart Edit that nobody has touched: re-analysis may replace it. The browser
        # editor bumps clips.edit_version on every save, which is what makes an edit "the person's".
        "auto": True,
        "video": video,
        "captions": {"enabled": True, "styleId": style_id or DEFAULT_STYLE, "overrides": {}, "words": caption_words},
        "broll": [],
        "audio": [],
        "texts": [],
        "zooms": build_zooms(ranges, punch_times),
        "look": "none",
        "hook": {"enabled": bool(hook_text), "text": hook_text, "durationSec": _r(min(HOOK_SECONDS, max(1.0, total / 3)))},
        "progressBar": {"enabled": True, "color": "#FFE600", "position": "bottom", "height": 10},
        "volume": 1,
        "duckLevel": 0.25,
        "safeZone": "tiktok",
    }


def summary(edit: dict[str, Any], start: float, end: float) -> dict[str, Any]:
    """What the smart edit did, for the job result / logs."""
    kept = sum(p["srcEnd"] - p["srcStart"] for p in edit["video"])
    return {
        "cuts": max(0, len(edit["video"]) - 1),
        "seconds_removed": round(max(0.0, (end - start) - kept), 2),
        "zoom_keys": len(edit["zooms"]),
        "emphasised_words": sum(1 for w in edit["captions"]["words"] if w.get("emph")),
    }
