"""Per-window audio-energy and shot-pacing features -> 0..100 sub-scores."""
from __future__ import annotations

import math
from typing import Any, Optional, Sequence

NEUTRAL = 50.0


def _slice(energy: Optional[dict[str, Any]], start: float, end: float) -> list[float]:
    if not energy:
        return []
    rms = energy.get("rms") or []
    hop = float(energy.get("hop") or 0.5)
    if not rms or hop <= 0:
        return []
    i0 = max(0, int(start / hop))
    i1 = min(len(rms), max(i0 + 1, math.ceil(end / hop)))
    return [float(x) for x in rms[i0:i1]]


def window_features(
    energy: Optional[dict[str, Any]], cuts: Optional[Sequence[float]], start: float, end: float
) -> dict[str, float]:
    """Raw stats plus `energy_score` and `cuts_score` (0..100)."""
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
    return {
        "mean": round(mean, 4),
        "peak": round(peak, 4),
        "variance": round(var, 4),
        "opening": round(opening, 4),
        "cuts_per_min": round(cpm, 3),
        "hop": hop,
        "energy_score": round(max(0.0, min(100.0, energy_score)), 2),
        "cuts_score": round(max(0.0, min(100.0, cuts_score)), 2),
    }
