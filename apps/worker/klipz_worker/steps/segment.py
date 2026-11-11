"""Words -> sentences -> candidate clip windows that start/end on sentence
boundaries."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from . import heuristics as H

Word = dict[str, Any]

MIN_LEN = 15.0
MAX_LEN = 90.0
TARGETS = (20.0, 30.0, 45.0, 60.0, 90.0)
MAX_CANDIDATES = 60
PAUSE_BREAK = 0.8
MAX_SENTENCE = 25.0
PAD_START = 0.15
PAD_END = 0.25


@dataclass
class Sentence:
    s: float
    e: float
    text: str
    words: list[Word] = field(repr=False, default_factory=list)
    spk: Optional[str] = None


@dataclass
class Candidate:
    start: float
    end: float
    sentences: list[Sentence] = field(repr=False)

    @property
    def duration(self) -> float:
        return self.end - self.start

    @property
    def text(self) -> str:
        return " ".join(s.text for s in self.sentences)

    @property
    def first_sentence(self) -> str:
        return self.sentences[0].text if self.sentences else ""

    def timestamped_text(self) -> str:
        return "\n".join(f"[{s.s:.1f}] {s.text}" for s in self.sentences)


def build_sentences(words: list[Word], pause: float = PAUSE_BREAK, max_len: float = MAX_SENTENCE) -> list[Sentence]:
    out: list[Sentence] = []
    start = 0
    for i, w in enumerate(words):
        last = i == len(words) - 1
        brk = last or bool(H.SENT_END_RE.search(str(w["w"]).strip()))
        if not brk:
            nxt = words[i + 1]
            brk = (nxt["s"] - w["e"] > pause) or (nxt["e"] - words[start]["s"] > max_len)
        if brk:
            chunk = words[start : i + 1]
            text = " ".join(str(x["w"]).strip() for x in chunk).strip()
            if text:
                out.append(Sentence(float(chunk[0]["s"]), float(chunk[-1]["e"]), text, chunk, chunk[0].get("spk")))
            start = i + 1
    return out


def sentences_to_segments(sentences: list[Sentence]) -> list[dict[str, Any]]:
    segs = []
    for s in sentences:
        seg: dict[str, Any] = {"s": round(s.s, 3), "e": round(s.e, 3), "text": s.text}
        if s.spk:
            seg["spk"] = s.spk
        segs.append(seg)
    return segs


def _cheap_score(c: Candidate) -> float:
    first = H.hook_strength(c.first_sentence)
    clean = (50 if H.starts_cleanly(c.first_sentence) else 0) + (50 if H.ends_cleanly(c.sentences[-1].text) else 0)
    n_words = sum(len(s.words) for s in c.sentences)
    wps = n_words / max(c.duration, 1e-6)
    density = max(0.0, 100.0 - abs(wps - 2.6) * 35)
    filler = 100.0 * (1 - min(1.0, H.filler_ratio(c.text) * 4))
    return 0.5 * first + 0.2 * clean + 0.15 * density + 0.15 * filler


def _make(sents: list[Sentence], duration: float) -> Candidate:
    start = max(0.0, sents[0].s - PAD_START)
    end = min(duration, sents[-1].e + PAD_END) if duration > 0 else sents[-1].e + PAD_END
    if end - start > MAX_LEN:  # padding must not push a max-length window past the cap
        end = start + MAX_LEN
        if end < sents[-1].e:
            end = sents[-1].e
            start = max(0.0, end - MAX_LEN) if end - start > MAX_LEN else start
    if end <= start:
        end = start + 0.5
    return Candidate(round(start, 3), round(end, 3), sents)


def generate_candidates(
    sentences: list[Sentence], duration: float, max_candidates: int = MAX_CANDIDATES
) -> list[Candidate]:
    """Windows of 15-90 s that begin at a sentence start and end at a sentence end."""
    if duration and duration < MIN_LEN:
        # Short video: the whole thing is the only sensible clip.
        sents = sentences or [Sentence(0.0, duration, "", [])]
        return [Candidate(0.0, round(duration, 3), sents)]
    if not sentences:
        return _blind_windows(duration)

    seen: set[tuple[int, int]] = set()
    cands: list[tuple[int, int, Candidate]] = []
    n = len(sentences)
    for i in range(n):
        spans: list[tuple[int, float]] = []
        for j in range(i, n):
            dur = sentences[j].e - sentences[i].s
            if dur > MAX_LEN:
                break
            if dur >= MIN_LEN:
                spans.append((j, dur))
        for target in TARGETS:
            if not spans:
                break
            j = min(spans, key=lambda t: (abs(t[1] - target), t[0]))[0]
            if (i, j) in seen:
                continue
            c = _make(sentences[i : j + 1], duration)
            near = any(
                (ci == i and abs(other.end - c.end) < 2.0) or (cj == j and abs(other.start - c.start) < 2.0)
                for ci, cj, other in cands
            )
            if near:
                continue
            seen.add((i, j))
            cands.append((i, j, c))
    if not cands:
        # Not enough speech for a 15 s window on sentence boundaries: take what there is.
        take: list[Sentence] = []
        for s in sentences:
            if take and s.e - take[0].s > MAX_LEN:
                break
            take.append(s)
        return [_make(take, duration)]
    ranked = sorted((c for _, _, c in cands), key=_cheap_score, reverse=True)[:max_candidates]
    return sorted(ranked, key=lambda c: c.start)


def _blind_windows(duration: float) -> list[Candidate]:
    """No usable transcript: fixed 30 s windows so the pipeline still yields clips."""
    out: list[Candidate] = []
    t = 0.0
    while t + MIN_LEN <= duration and len(out) < MAX_CANDIDATES:
        e = min(duration, t + 30.0)
        out.append(Candidate(round(t, 3), round(e, 3), []))
        t += 30.0
    return out
