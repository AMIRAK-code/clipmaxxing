"""Words -> sentences -> candidate clip windows that start/end on sentence
boundaries."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from . import heuristics as H

Word = dict[str, Any]

MIN_LEN = 15.0
MAX_LEN = 60.0
TARGETS = (15.0, 20.0, 30.0, 45.0, 60.0)
MAX_CANDIDATES = 60   # floor of the candidate pool; long videos get more (pool_size)
MAX_POOL = 600
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
    # the sentence said just before the window (context for an AI scorer: what "it" / "that" refers to)
    before: str = field(default="", repr=False)

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


def max_len_for(duration: float) -> float:
    """Longest clip for a video of this length: a quarter of it, never under 20 s nor over 60 s.
    A 2-minute video gives clips up to 30 s, 3 minutes up to 45 s, 4 minutes and more up to a minute."""
    if not duration or duration <= 0:
        return MAX_LEN
    return float(min(MAX_LEN, max(20.0, round(duration / 4.0, 1)), max(MIN_LEN, duration)))


def targets_for(max_len: float) -> tuple[float, ...]:
    t = [x for x in TARGETS if x <= max_len + 1e-6]
    if not t or max_len - t[-1] >= 4.0:
        t.append(max_len)
    return tuple(t)


def pool_size(duration: float) -> int:
    """How many candidate windows to score: about one per 2 s of video, between 60 and 600. Most of them
    overlap (several lengths per starting sentence), so a big pool is what lets a long video offer many
    distinct clips. An AI scorer only rates the best LLM_POOL of them (steps/score.py)."""
    return int(min(MAX_POOL, max(MAX_CANDIDATES, (duration or 0) / 2.0)))


def _cheap_score(c: Candidate) -> float:
    first = H.hook_strength(c.first_sentence)
    clean = (50 if H.starts_cleanly(c.first_sentence) else 0) + (50 if H.ends_cleanly(c.sentences[-1].text) else 0)
    n_words = sum(len(s.words) for s in c.sentences)
    wps = n_words / max(c.duration, 1e-6)
    density = max(0.0, 100.0 - abs(wps - 2.6) * 35)
    filler = 100.0 * (1 - min(1.0, H.filler_ratio(c.text) * 4))
    lively = 100.0 * H.excitement(c.text)
    return 0.42 * first + 0.18 * clean + 0.12 * density + 0.12 * filler + 0.16 * lively


def _make(sents: list[Sentence], duration: float, max_len: float = MAX_LEN) -> Candidate:
    start = max(0.0, sents[0].s - PAD_START)
    end = min(duration, sents[-1].e + PAD_END) if duration > 0 else sents[-1].e + PAD_END
    if end - start > max_len:  # padding must not push a max-length window past the cap
        end = start + max_len
        if end < sents[-1].e:
            end = sents[-1].e
            start = max(0.0, end - max_len) if end - start > max_len else start
    if end <= start:
        end = start + 0.5
    return Candidate(round(start, 3), round(end, 3), sents)


def generate_candidates(
    sentences: list[Sentence], duration: float, max_candidates: Optional[int] = None
) -> list[Candidate]:
    """Windows of 15 s up to max_len_for(duration) (at most 60 s) that begin at a sentence start and end
    at a sentence end. Returns the `max_candidates` (default pool_size(duration)) most promising ones."""
    max_len = max_len_for(duration)
    targets = targets_for(max_len)
    if max_candidates is None:
        max_candidates = pool_size(duration)
    if duration and duration < MIN_LEN:
        # Short video: the whole thing is the only sensible clip.
        sents = sentences or [Sentence(0.0, duration, "", [])]
        return [Candidate(0.0, round(duration, 3), sents)]
    if not sentences:
        return _blind_windows(duration, max_len, max_candidates)

    seen: set[tuple[int, int]] = set()
    cands: list[tuple[int, int, Candidate]] = []
    n = len(sentences)
    for i in range(n):
        spans: list[tuple[int, float]] = []
        for j in range(i, n):
            dur = sentences[j].e - sentences[i].s
            # the padding added around the speech counts against the limit, so a clip always ends on a
            # sentence boundary instead of being cut to length
            if dur + PAD_START + PAD_END > max_len:
                break
            if dur >= MIN_LEN:
                spans.append((j, dur))
        for target in targets:
            if not spans:
                break
            j = min(spans, key=lambda t: (abs(t[1] - target), t[0]))[0]
            if (i, j) in seen:
                continue
            c = _make(sentences[i : j + 1], duration, max_len)
            if i > 0:
                c.before = sentences[i - 1].text
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
            if take and s.e - take[0].s > max_len:
                break
            take.append(s)
        return [_make(take, duration, max_len)]
    ranked = sorted((c for _, _, c in cands), key=_cheap_score, reverse=True)[:max_candidates]
    return sorted(ranked, key=lambda c: c.start)


def _blind_windows(duration: float, max_len: float = MAX_LEN, limit: int = MAX_CANDIDATES) -> list[Candidate]:
    """No usable transcript (music, gameplay without talk): fixed windows so the pipeline still yields
    clips; the audio hype score then decides which ones are worth keeping."""
    out: list[Candidate] = []
    size = min(30.0, max_len)
    step = size / 2.0  # half-overlapping, so a peak near a boundary still sits inside one window
    t = 0.0
    while t + MIN_LEN <= duration and len(out) < limit:
        e = min(duration, t + size)
        out.append(Candidate(round(t, 3), round(e, 3), []))
        t += step
    return out
