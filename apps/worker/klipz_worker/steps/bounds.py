"""Clip edges that make sense: start with the context a clip needs, end when the thought is finished.

Candidate windows (segment.py) start and end on "sentences", but a sentence there is also any stretch
between two pauses, so a chosen moment can open on "And then it..." (what is "it"?), answer a question
the clip never asks, or stop before the speaker has finished. refine_bounds() looks just outside a
chosen window and moves its edges a little:

  * start: back to the previous sentence when the clip opens on a connector or pronoun ("and", "so",
    "because", "it", "that" ...), or when the sentence right before it is the question it answers;
  * end: on to the end of the sentence when the clip stops mid-thought (no closing punctuation), or on
    to a short payoff that follows ("that's why ...", "and that's the point.").

Edges move by at most MAX_EXTEND seconds (or MAX_EXTEND_FRAC of the clip, if smaller) in total, never
past the video, and always land on the sentence padding of segment.py. Pure functions over plain data.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Sequence

from . import heuristics as H
from .segment import PAD_END, PAD_START, Sentence

MAX_EXTEND = 6.0          # seconds a clip may grow in total ...
MAX_EXTEND_FRAC = 0.15    # ... or this share of its length, whichever is smaller
MAX_BACK = 8.0            # the sentences added before a clip are at most this long together
LINK_GAP = 1.5            # a sentence belongs with the clip only when the pause between them is short
MAX_BACK_SENTENCES = 2
PAYOFF_MAX = 4.0          # a following payoff sentence is short


@dataclass
class Refined:
    start: float
    end: float
    sentences: list[Sentence]
    reasons: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.reasons)


def is_complete(s: Sentence) -> bool:
    """The sentence ends on real punctuation (not a pause or the 25 s limit)."""
    return H.ends_cleanly(s.text)


def is_question(s: Sentence) -> bool:
    return s.text.rstrip().rstrip("\"')]").endswith("?")


def _same_speaker(a: Sentence, b: Sentence) -> bool:
    return not a.spk or not b.spk or a.spk == b.spk


def _is_payoff(s: Sentence) -> bool:
    low = s.text.lower()
    return s.e - s.s <= PAYOFF_MAX and is_complete(s) and (
        any(p in low for p in H.CONCLUSION_PHRASES) or s.text.rstrip().endswith("!")
    )


def _index_range(sentences: Sequence[Sentence], start: float, end: float) -> Optional[tuple[int, int]]:
    inside = [i for i, s in enumerate(sentences) if s.e > start and s.s < end]
    return (inside[0], inside[-1]) if inside else None


def refine_bounds(start: float, end: float, sentences: Sequence[Sentence], duration: float) -> Refined:
    """Better edges for the clip [start, end] (see the module docstring); unchanged when none apply."""
    span = _index_range(sentences, start, end)
    if span is None:
        return Refined(start, end, [])
    i0, j0 = span
    budget = min(MAX_EXTEND, MAX_EXTEND_FRAC * (end - start))
    reasons: list[str] = []
    new_start, new_end = start, end

    # ── start: bring in the context ─────────────────────────────────────
    i = i0
    added = 0.0
    for _ in range(MAX_BACK_SENTENCES):
        if i == 0:
            break
        first, prev = sentences[i], sentences[i - 1]
        weak = not H.starts_cleanly(first.text)
        answers = is_question(prev)
        if not (weak or answers) or first.s - prev.e > LINK_GAP or not _same_speaker(first, prev):
            break
        cand_start = max(0.0, prev.s - PAD_START)
        if added + (first.s - prev.s) > MAX_BACK or (start - cand_start) > budget:
            break
        added += first.s - prev.s
        new_start = cand_start
        i -= 1
        reasons.append("starts with the question it answers" if answers else "starts with its context")
        if answers:
            break  # the question is the context: no need to go further back
    budget -= max(0.0, start - new_start)

    # ── end: finish the thought ─────────────────────────────────────────
    j = j0
    last = sentences[j]
    limit = min(duration, end + budget) if duration > 0 else end + budget
    if not is_complete(last):
        for k in range(j0 + 1, len(sentences)):
            nxt = sentences[k]
            if nxt.s - sentences[k - 1].e > LINK_GAP or nxt.e + PAD_END > limit:
                break
            if is_complete(nxt):
                j = k
                reasons.append("ends when the sentence ends")
                break
    elif j0 + 1 < len(sentences):
        nxt = sentences[j0 + 1]
        if nxt.s - last.e <= LINK_GAP and _is_payoff(nxt) and nxt.e + PAD_END <= limit and _same_speaker(last, nxt):
            j = j0 + 1
            reasons.append("ends on its payoff")
    if j != j0:
        new_end = sentences[j].e + PAD_END
        if duration > 0:
            new_end = min(duration, new_end)
    new_end = max(new_end, end)
    return Refined(round(new_start, 3), round(new_end, 3), list(sentences[i : j + 1]), reasons)
