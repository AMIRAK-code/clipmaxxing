"""One-Euro filter (Casiez, Roussel, Vogel 2012): a low-pass whose cutoff rises
with the signal's speed, so it removes jitter at rest yet follows fast moves
with little lag."""
from __future__ import annotations

import math
from typing import Optional, Sequence


def _alpha(cutoff: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class OneEuroFilter:
    def __init__(self, min_cutoff: float = 0.4, beta: float = 1.0, d_cutoff: float = 1.0):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x: Optional[float] = None
        self._dx: float = 0.0
        self._t: Optional[float] = None

    def reset(self) -> None:
        self._x, self._dx, self._t = None, 0.0, None

    def __call__(self, x: float, t: float) -> float:
        """Filter sample x taken at time t (seconds, strictly increasing)."""
        if self._x is None or self._t is None:
            self._x, self._dx, self._t = x, 0.0, t
            return x
        dt = max(1e-6, t - self._t)
        dx = (x - self._x) / dt
        a_d = _alpha(self.d_cutoff, dt)
        self._dx = a_d * dx + (1 - a_d) * self._dx
        cutoff = self.min_cutoff + self.beta * abs(self._dx)
        a = _alpha(cutoff, dt)
        self._x = a * x + (1 - a) * self._x
        self._t = t
        return self._x


def smooth_series(
    times: Sequence[float],
    values: Sequence[float],
    min_cutoff: float = 0.6,
    beta: float = 1.5,
    d_cutoff: float = 1.0,
) -> list[float]:
    f = OneEuroFilter(min_cutoff, beta, d_cutoff)
    return [f(v, t) for t, v in zip(times, values)]


def dead_zone(values: Sequence[float], width: float) -> list[float]:
    """Hold the previous output until the input moves more than `width` away
    from it; then follow (staying `width` behind so there is no jump)."""
    out: list[float] = []
    held: Optional[float] = None
    for v in values:
        if held is None:
            held = v
        elif v - held > width:
            held = v - width
        elif held - v > width:
            held = v + width
        out.append(held)
    return out
