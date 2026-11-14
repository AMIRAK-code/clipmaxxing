"""Per-window audio and shot-pacing features -> 0..100 sub-scores.

`energy` is what ingest stores for a source (ffmpeg.audio_energy): per-hop loudness (`rms`) and, since
version 2, spectral brightness (`bright`) and spectral change (`flux`). Everything here is relative to the
video's own baseline: a loud podcast and a quiet vlog are judged against themselves, so "hype" means
"more worked-up than the rest of this video", not "loud".
"""
from __future__ import annotations

import math
from typing import Any, Optional, Sequence

NEUTRAL = 50.0


def _slice(energy: Optional[dict[str, Any]], start: float, end: float, key: str = "rms") -> list[float]:
    if not energy:
        return []
    vals = energy.get(key) or []
    hop = float(energy.get("hop") or 0.5)
    if not vals or hop <= 0:
        return []
    i0 = max(0, int(start / hop))
    i1 = min(len(vals), max(i0 + 1, math.ceil(end / hop)))
    return [float(x) for x in vals[i0:i1]]


def _pct(sorted_vals: Sequence[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    i = min(len(sorted_vals) - 1, max(0, int(round(q * (len(sorted_vals) - 1)))))
    return float(sorted_vals[i])


def _mean(vals: Sequence[float]) -> float:
    return sum(vals) / len(vals) if vals else 0.0


def _rel(value: float, base: float, span: float = 0.5) -> float:
    """0..100 where `base` maps to 50 and base * (1 + span) to 100."""
    if base <= 1e-6:
        return NEUTRAL
    return max(0.0, min(100.0, 50.0 + 50.0 * ((value / base) - 1.0) / span))


class AudioProfile:
    """The video's own loudness / brightness / flux baseline, computed once and shared by every window."""

    def __init__(self, energy: Optional[dict[str, Any]]):
        self.energy = energy if energy and (energy.get("rms") or []) else None
        rms = sorted(float(x) for x in (energy or {}).get("rms") or [])
        # baseline over the parts where someone is actually making sound
        voiced = [x for x in rms if x > 0.05] or rms
        self.median = _pct(voiced, 0.5)
        # a "burst" is a hop in the upper part of this video's own dynamic range; a video with no range has none
        p95 = _pct(voiced, 0.95)
        self.p85 = self.median + 0.6 * (p95 - self.median) if p95 - self.median >= 0.05 else 0.0
        self.bright_mean = _mean([float(x) for x in (energy or {}).get("bright") or [] if x > 0])
        self.flux_mean = _mean([float(x) for x in (energy or {}).get("flux") or [] if x > 0])

    def hype(self, start: float, end: float) -> Optional[dict[str, float]]:
        """Audio excitement of [start, end) against the video's baseline, or None without audio data.

        loud    window loudness vs the video's median
        bursts  share of the window spent in the top of the video's loudness range (shouts, laughter, emphasis)
        bright  spectral brightness vs the video's mean (raised / shouted voices, cheering)
        flux    spectral change vs the video's mean (fast delivery, laughter, crowd, action)
        swing   loudness range inside the window (monotone delivery scores low)
        opening the first 3 s vs the median: does it start with energy
        build   last third vs first third: does it build towards the end
        """
        e = self.energy
        if e is None:
            return None
        vals = _slice(e, start, end)
        if not vals:
            return None
        mean = _mean(vals)
        third = max(1, len(vals) // 3)
        out = {
            "loud": _rel(mean, self.median, 0.5),
            "bursts": max(0.0, min(100.0, 100.0 * (sum(1 for v in vals if v > self.p85) / len(vals)) / 0.45)) if self.p85 > 0 else 0.0,
            "swing": max(0.0, min(100.0, 100.0 * (max(vals) - _pct(sorted(vals), 0.2)) / 0.7)),
            "opening": _rel(_mean(_slice(e, start, min(end, start + 3.0))), self.median, 0.5),
            "build": max(0.0, min(100.0, 50.0 + 120.0 * (_mean(vals[-third:]) - _mean(vals[:third])))),
        }
        weights = {"loud": 0.26, "bursts": 0.24, "swing": 0.12, "opening": 0.12, "build": 0.06}
        bright, flux = _slice(e, start, end, "bright"), _slice(e, start, end, "flux")
        if bright and self.bright_mean > 0:
            out["bright"] = _rel(_mean(bright), self.bright_mean, 0.4)
            weights["bright"] = 0.10
        if flux and self.flux_mean > 0:
            out["flux"] = _rel(_mean(flux), self.flux_mean, 0.5)
            weights["flux"] = 0.10
        total = sum(weights.values())
        out["score"] = round(sum(out[k] * w for k, w in weights.items()) / total, 2)
        return out


def window_features(
    energy: Optional[dict[str, Any]], cuts: Optional[Sequence[float]], start: float, end: float,
    profile: Optional[AudioProfile] = None,
) -> dict[str, float]:
    """Raw stats plus `energy_score`, `cuts_score` and `audio_hype` (0..100; 50 = unknown)."""
    dur = max(1e-6, end - start)
    vals = _slice(energy, start, end)
    if vals:
        mean = sum(vals) / len(vals)
        peak = max(vals)
        var = sum((v - mean) ** 2 for v in vals) / len(vals)
        hop = float(energy.get("hop") or 0.5) if energy else 0.5
        opening_vals = _slice(energy, start, start + 3.0)
        opening = sum(opening_vals) / len(opening_vals) if opening_vals else mean
        std = math.sqrt(var)
        energy_score = 100.0 * (0.4 * mean + 0.3 * opening + 0.2 * peak + 0.1 * min(1.0, std * 3))
    else:
        mean = peak = var = opening = 0.0
        hop = 0.5
        energy_score = NEUTRAL
    if cuts is None:
        cpm, cuts_score = 0.0, NEUTRAL
    else:
        n = sum(1 for c in cuts if start <= c < end)
        cpm = n / (dur / 60.0)
        # ~12 cuts/min reads as "well paced"; a locked-off talking head scores low but only has 10% weight.
        cuts_score = 100.0 * min(1.0, cpm / 12.0)
    hype = (profile or AudioProfile(energy)).hype(start, end)
    return {
        "mean": round(mean, 4),
        "peak": round(peak, 4),
        "variance": round(var, 4),
        "opening": round(opening, 4),
        "cuts_per_min": round(cpm, 3),
        "hop": hop,
        "energy_score": round(max(0.0, min(100.0, energy_score)), 2),
        "cuts_score": round(max(0.0, min(100.0, cuts_score)), 2),
        "audio_hype": hype["score"] if hype else NEUTRAL,
        "has_audio_hype": 1.0 if hype else 0.0,
    }
