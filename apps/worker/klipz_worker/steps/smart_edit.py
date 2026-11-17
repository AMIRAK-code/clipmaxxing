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

import logging
import re
import wave
from pathlib import Path
from typing import Any, Optional, Sequence

from . import heuristics as H

log = logging.getLogger(__name__)

# ── tuning ────────────────────────────────────────────────────────────────
MAX_GAP = 0.7           # silence longer than this between two words is cut ...
MIN_OUTPUT = 15.0       # ... but never so much that the finished clip drops under this (when it started above it)
RELAXED_GAPS = (1.0, 1.5, 2.0)
# ... keeping air on both sides of the cut. Whisper's word times are tight and its word ends tend to be
# early (the last sound of a word, a breath or the room's decay come after), so more is kept after speech
# than before it: cutting right at the word times is what makes a jump cut sound chopped.
LEAD_PAD = 0.15         # before speech starts again
TAIL_PAD = 0.28         # after speech stops
MIN_CUT = 0.25          # a cut that would remove less than this is not worth the jump
MIN_PIECE = 0.35        # never leave a sliver shorter than this
SNAP_MAX = 0.25         # with the source audio, a cut point may move this far to land in quiet (QuietSnap)
FILLER_WORDS = {"um", "uh", "uhm", "umm", "er", "erm", "hmm", "mm", "ah"}
FILLER_MIN_GAP = 0.12   # a filler is only cut when there is a little silence on both sides (clean cut)
FILLER_CLEAR = 0.03     # the air kept around a cut never reaches into the filler that was cut out
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


class QuietSnap:
    """Loudness of a stretch of the source's audio in 10 ms steps, to move cut points into quiet.

    Built from the 16 kHz mono WAV that ingest keeps (sources/<id>/audio.wav). "Quiet" is relative to the
    stretch itself: close to its noise floor and well under its speech level. When the stretch has no
    clear quiet/loud contrast (music, constant noise) it never moves anything."""

    STEP = 0.01
    RUN = 3  # 30 ms of quiet in a row

    def __init__(self, db: Sequence[float], t0: float):
        import numpy as np

        self.t0 = t0
        self.db = np.asarray(db, dtype=float)
        self.usable = False
        self.threshold = -1e9
        if self.db.size >= 20:
            floor, speech = float(np.percentile(self.db, 10)), float(np.percentile(self.db, 90))
            if speech - floor >= 12.0:
                self.usable = True
                self.threshold = max(floor + 8.0, speech - 30.0)

    @classmethod
    def from_samples(cls, samples: Any, sr: int, t0: float) -> "QuietSnap":
        import numpy as np

        x = np.asarray(samples, dtype=np.float32)
        hop = max(1, int(round(sr * cls.STEP)))
        n = len(x) // hop
        if n == 0:
            return cls([], t0)
        frames = x[: n * hop].reshape(n, hop)
        rms = np.sqrt(np.mean(frames * frames, axis=1)) + 1e-9
        return cls(20.0 * np.log10(rms), t0)

    @classmethod
    def from_wav(cls, path: Path | str, start: float, end: float, margin: float = 1.0) -> Optional["QuietSnap"]:
        """The stretch [start - margin, end + margin] of a 16-bit PCM WAV; None when it cannot be read."""
        import numpy as np

        try:
            with wave.open(str(path), "rb") as wf:
                sr, ch, width = wf.getframerate(), wf.getnchannels(), wf.getsampwidth()
                if width != 2:
                    return None
                a = max(0, int((start - margin) * sr))
                b = min(wf.getnframes(), int((end + margin) * sr))
                if b <= a:
                    return None
                wf.setpos(a)
                raw = wf.readframes(b - a)
        except (OSError, EOFError, wave.Error) as e:
            log.info("no audio for quiet snapping (%s)", e)
            return None
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            x = x.reshape(-1, ch).mean(axis=1)
        return cls.from_samples(x, sr, a / sr)

    def _i(self, t: float) -> int:
        return int(round((t - self.t0) / self.STEP))

    def _t(self, i: int) -> float:
        return self.t0 + i * self.STEP

    def _quiet(self, i0: int, i1: int) -> bool:
        if i0 < 0 or i1 > len(self.db) or i1 <= i0:
            return False
        return bool((self.db[i0:i1] <= self.threshold).all())

    def later(self, t: float, limit: float) -> float:
        """A cut-out point at or after `t` (at most `limit`) where the sound has died down."""
        if not self.usable or limit <= t:
            return t
        i, last = self._i(t), self._i(limit)
        for j in range(i, last - self.RUN + 2):
            if self._quiet(j, j + self.RUN):
                return min(limit, max(t, self._t(j)))
        return t

    def earlier(self, t: float, limit: float) -> float:
        """A cut-in point at or before `t` (at least `limit`) with quiet just before it."""
        if not self.usable or limit >= t:
            return t
        i, first = self._i(t), self._i(limit)
        for j in range(i, first + self.RUN - 1, -1):
            if self._quiet(j - self.RUN, j):
                return max(limit, min(t, self._t(j)))
        return t


def snap_for(audio_path: Optional[Path | str], start: float, end: float) -> Optional[QuietSnap]:
    """QuietSnap for a clip of the source whose audio is at `audio_path`; None without audio."""
    if not audio_path or not Path(audio_path).exists():
        return None
    return QuietSnap.from_wav(audio_path, start, end)


def keep_ranges(words: Sequence[dict[str, Any]], start: float, end: float, max_gap: float = MAX_GAP,
                drop_fillers: bool = True, snap: Optional[QuietSnap] = None) -> list[tuple[float, float]]:
    """Source-time ranges to keep: the clip minus silences longer than `max_gap` and isolated filler words.
    Every cut keeps LEAD_PAD of air before the speech that follows it and TAIL_PAD after the speech before
    it; a cut that would remove less than MIN_CUT is not made. With `snap` (the clip's audio), each cut
    point then moves up to SNAP_MAX further into the pause until the sound there is quiet: Whisper's word
    ends are often early, and this is what keeps a word's last sound or a breath from being clipped."""
    ws = [w for w in words if w["e"] > start and w["s"] < end]
    if not ws:
        return [(start, end)]
    spoken: list[tuple[float, float]] = []
    dropped: list[tuple[float, float]] = []
    for i, w in enumerate(ws):
        if _norm(str(w["w"])) in FILLER_WORDS:
            before = w["s"] - (ws[i - 1]["e"] if i > 0 else start)
            after = (ws[i + 1]["s"] if i + 1 < len(ws) else end) - w["e"]
            if drop_fillers and before >= FILLER_MIN_GAP and after >= FILLER_MIN_GAP:
                dropped.append((float(w["s"]), float(w["e"])))
                continue  # drop it: the gap it leaves is closed below
        spoken.append((max(start, float(w["s"])), min(end, float(w["e"]))))
    if not spoken:
        return [(start, end)]
    ranges: list[list[float]] = []
    for s, e in spoken:
        if ranges and s - ranges[-1][1] <= max_gap and not any(ranges[-1][1] <= f0 < s for f0, _f1 in dropped):
            ranges[-1][1] = max(ranges[-1][1], e)
        else:
            ranges.append([s, e])
    padded: list[tuple[float, float]] = []
    for s, e in ranges:
        lo = max(start, s - LEAD_PAD)
        hi = min(end, e + TAIL_PAD)
        # the air around a cut must not bring back the filler that was cut out
        for f0, f1 in dropped:
            if e <= f0 and hi > f0 - FILLER_CLEAR:
                hi = max(e, f0 - FILLER_CLEAR)
            if f1 <= s and lo < f1 + FILLER_CLEAR:
                lo = min(s, f1 + FILLER_CLEAR)
        padded.append((lo, hi))
    if snap is not None:
        # only cut points inside the clip move, and never past the speech or a cut filler on the other side
        for k in range(len(padded)):
            lo, hi = padded[k]
            if k > 0:
                floor = ranges[k - 1][1]
                for f0, f1 in dropped:
                    if ranges[k - 1][1] <= f0 and f1 <= ranges[k][0]:
                        floor = max(floor, f1 + FILLER_CLEAR)
                lo = snap.earlier(lo, max(start, lo - SNAP_MAX, floor))
            if k + 1 < len(padded):
                ceil = ranges[k + 1][0]
                for f0, f1 in dropped:
                    if ranges[k][1] <= f0 and f1 <= ranges[k + 1][0]:
                        ceil = min(ceil, f0 - FILLER_CLEAR)
                hi = snap.later(hi, min(end, hi + SNAP_MAX, ceil))
            padded[k] = (lo, hi)
    out: list[tuple[float, float]] = []
    for lo, hi in padded:
        if out and lo - out[-1][1] < MIN_CUT and not any(out[-1][1] <= f0 and f1 <= lo for f0, f1 in dropped):
            out[-1] = (out[-1][0], hi)  # too little to cut: keep the pause as it is
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


def fitted_ranges(words: Sequence[dict[str, Any]], start: float, end: float, min_output: float = MIN_OUTPUT,
                  snap: Optional[QuietSnap] = None) -> list[tuple[float, float]]:
    """keep_ranges(), cutting less (longer pauses allowed, then no cuts at all) whenever the usual cuts
    would leave a clip shorter than `min_output`. A clip that is shorter than that to begin with is cut
    normally: there is no minimum to protect."""
    ranges = keep_ranges(words, start, end, snap=snap)
    if end - start < min_output:
        return ranges
    kept = lambda rs: sum(e - s for s, e in rs)  # noqa: E731
    if kept(ranges) >= min_output:
        return ranges
    for gap in RELAXED_GAPS:
        ranges = keep_ranges(words, start, end, max_gap=gap, drop_fillers=False, snap=snap)
        if kept(ranges) >= min_output:
            return ranges
    return [(start, end)]


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
    snap: Optional[QuietSnap] = None,
) -> dict[str, Any]:
    """A complete EditState (packages/shared/src/types.ts) for the clip [start, end] of the source.
    `snap` (snap_for(source audio, start, end)) lets cut points settle into quiet audio."""
    start, end = float(start), float(end)
    ws = [w for w in words if w["e"] > start and w["s"] < end and str(w["w"]).strip()]
    ranges = fitted_ranges(ws, start, end, snap=snap)
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
