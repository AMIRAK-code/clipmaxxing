"""Greedy non-overlapping selection."""
from __future__ import annotations

from typing import Iterable, Protocol, Sequence, TypeVar


class _Span(Protocol):
    @property
    def start(self) -> float: ...
    @property
    def end(self) -> float: ...
    @property
    def score(self) -> float: ...


T = TypeVar("T", bound=_Span)


def overlap_fraction(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Overlap as a fraction of the shorter span."""
    inter = min(a_end, b_end) - max(a_start, b_start)
    if inter <= 0:
        return 0.0
    return inter / max(1e-9, min(a_end - a_start, b_end - b_start))


def select_top(items: Iterable[T], max_clips: int = 8, max_overlap: float = 0.10, taken: Sequence[T] = ()) -> list[T]:
    """Best-first picks that overlap each other (and anything in `taken`) by at most `max_overlap`.
    Returns only the new picks, best first."""
    chosen: list[T] = []
    for it in sorted(items, key=lambda x: (-x.score, x.start)):
        if len(chosen) >= max_clips:
            break
        if all(overlap_fraction(it.start, it.end, c.start, c.end) <= max_overlap for c in (*taken, *chosen)):
            chosen.append(it)
    return sorted(chosen, key=lambda x: -x.score)
