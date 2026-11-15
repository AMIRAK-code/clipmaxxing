"""Right-to-left text at word granularity: a port of packages/shared/src/bidi.ts.

Both renderers place every caption word themselves, so they must agree on the order of the words in a
line and on the direction each word is drawn in. Keep this file and bidi.ts in step.
"""
from __future__ import annotations

import unicodedata
from typing import Iterable, Optional, Sequence

LTR, RTL = "ltr", "rtl"

# Blocks whose letters are written right to left (Hebrew, Arabic, Syriac, Thaana, N'Ko ...)
_RTL_RANGES = ((0x0590, 0x08FF), (0xFB1D, 0xFDFF), (0xFE70, 0xFEFF), (0x10800, 0x10FFF), (0x1E800, 0x1EFFF))
# Of those, the scripts whose letters join (Arabic and its relatives): letter-spacing would break them
_CURSIVE_RANGES = ((0x0600, 0x08FF), (0xFB50, 0xFDFF), (0xFE70, 0xFEFF))


def _in(cp: int, ranges: Sequence[tuple[int, int]]) -> bool:
    return any(a <= cp <= b for a, b in ranges)


def strong_counts(text: str) -> tuple[int, int]:
    """(right-to-left letters, left-to-right letters); digits, punctuation and marks have no direction."""
    rtl = ltr = 0
    for ch in text:
        if not unicodedata.category(ch).startswith("L"):
            continue
        if _in(ord(ch), _RTL_RANGES):
            rtl += 1
        else:
            ltr += 1
    return rtl, ltr


def base_direction(texts: Iterable[str]) -> str:
    """Reading direction of a body of text: right to left when most of its letters are."""
    rtl = ltr = 0
    for t in texts:
        r, l = strong_counts(t)
        rtl, ltr = rtl + r, ltr + l
    return RTL if rtl > ltr else LTR


def word_direction(word: str) -> Optional[str]:
    rtl, ltr = strong_counts(word)
    return RTL if rtl > 0 else LTR if ltr > 0 else None


def has_cursive_script(text: str) -> bool:
    return any(_in(ord(ch), _CURSIVE_RANGES) for ch in text)


def _has_digit(word: str) -> bool:
    return any(unicodedata.category(ch) == "Nd" for ch in word)


def resolve_word_directions(words: Sequence[str], base: str) -> list[str]:
    """Direction of every word of a line. Words without letters (numbers, punctuation) follow the line,
    except inside a run of the other direction: after a foreign word when they are a number or when a
    foreign word follows too ("Windows 10 Pro" stays together inside a Persian sentence)."""
    own = [word_direction(w) for w in words]
    other = LTR if base == RTL else RTL
    out: list[str] = []
    for i, d in enumerate(own):
        if d:
            out.append(d)
            continue
        prev = next((own[j] for j in range(i - 1, -1, -1) if own[j]), None)
        if prev != other:
            out.append(base)
            continue
        nxt = next((own[j] for j in range(i + 1, len(own)) if own[j]), None)
        out.append(other if _has_digit(words[i]) or nxt == other else base)
    return out


def visual_order(dirs: Sequence[str], base: str) -> list[int]:
    """Indexes of a line's words from left to right on screen. In a right-to-left line the words run
    from the right, but a run of left-to-right words keeps its own order (and the other way round)."""
    order = list(range(len(dirs)))
    if base == RTL:
        order.reverse()
    out: list[int] = []
    i = 0
    while i < len(order):
        j = i
        while j < len(order) and dirs[order[j]] == dirs[order[i]]:
            j += 1
        run = order[i:j]
        if dirs[order[i]] != base:
            run.reverse()
        out.extend(run)
        i = j
    return out
