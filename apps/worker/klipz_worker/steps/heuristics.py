"""Cheap, dependency-free text heuristics shared by segmentation (pre-ranking)
and the offline HeuristicScorer."""
from __future__ import annotations

import re
from collections import Counter

HOOK_WORDS = {
    "secret", "never", "nobody", "everyone", "mistake", "mistakes", "truth", "stop", "biggest", "worst", "best",
    "imagine", "why", "how", "what", "wrong", "myth", "shocking", "crazy", "insane", "actually", "free", "easy",
    "fastest", "simple", "hack", "lesson", "warning", "real", "reason", "changed", "ever", "only", "first",
    "always", "problem", "learned", "wish", "unbelievable", "nobody's", "you",
}
INTERROGATIVES = {"what", "why", "how", "did", "do", "does", "have", "ever", "imagine", "who", "when", "is", "are",
                  "can", "would", "should", "ready"}
INTENSE_WORDS = {
    "amazing", "incredible", "insane", "crazy", "terrible", "awful", "love", "hate", "angry", "scared", "afraid",
    "shocked", "huge", "massive", "never", "always", "worst", "best", "wow", "unbelievable", "hilarious", "disaster",
    "fantastic", "horrible", "obsessed", "furious", "heartbreaking", "devastating", "mind-blowing", "literally",
    "absolutely", "completely", "totally", "impossible", "ridiculous",
}
FILLERS = {"um", "uh", "er", "erm", "like", "yeah", "basically", "actually", "literally", "kinda", "sorta", "hmm"}
FILLER_PHRASES = ("you know", "i mean", "kind of", "sort of", "i guess", "or something")
WEAK_STARTS = {"and", "but", "so", "because", "um", "uh", "like", "yeah", "well", "or", "then", "which", "that",
               "it", "they", "he", "she", "this", "these", "those", "also", "anyway", "okay", "ok", "right"}
CONCLUSION_PHRASES = ("that's why", "that is why", "the key", "in the end", "the lesson", "remember", "so the",
                      "bottom line", "the point", "that's how", "which means", "the result", "turns out",
                      "and that's", "that's the")
STOPWORDS = set(
    "a an the and or but if then so of to in on at by for with about as is are was were be been being am do does "
    "did have has had i me my we our you your he she it its they them their this that these those there here not no "
    "yes just very really can could would should will than too also into out up down over from what when where which "
    "who whom how why all any each more most some such only own same other so than s t don now get got like um uh "
    "yeah okay ok well one thing things going gonna know think mean right say said says see make made".split()
)

_WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'\-]*")
SENT_END_RE = re.compile(r"[.!?…]+[\"')\]]*$")


def tokens(text: str) -> list[str]:
    return [t.lower() for t in _WORD_RE.findall(text)]


def filler_ratio(text: str) -> float:
    toks = tokens(text)
    if not toks:
        return 0.0
    low = text.lower()
    n = sum(1 for t in toks if t in FILLERS) + sum(low.count(p) * 2 for p in FILLER_PHRASES)
    return min(1.0, n / len(toks))


def hook_strength(first_sentence: str) -> float:
    """0..100: how much does this opening line make you want to keep watching?"""
    text = first_sentence.strip()
    toks = tokens(text)
    if not toks:
        return 0.0
    score = 20.0
    if "?" in text:
        score += 30
    if toks[0] in INTERROGATIVES:
        score += 10
    score += min(24, 8 * sum(1 for t in set(toks) if t in HOOK_WORDS))
    if re.search(r"\d", text):
        score += 10
    if "!" in text:
        score += 5
    n = len(toks)
    if 4 <= n <= 18:
        score += 12
    elif n > 30:
        score -= 15
    elif n < 3:
        score -= 10
    if toks[0] in WEAK_STARTS:
        score -= 15
    score -= 30 * filler_ratio(text)
    return max(0.0, min(100.0, score))


def intensity(text: str) -> float:
    """0..1 emotional-intensity proxy from punctuation and intense words."""
    toks = tokens(text)
    if not toks:
        return 0.0
    excl = text.count("!")
    caps = len(re.findall(r"\b[A-Z]{3,}\b", text))
    words = sum(1 for t in toks if t in INTENSE_WORDS)
    return min(1.0, (excl * 0.25 + caps * 0.15 + words * 0.2 + text.count("?") * 0.05))


def starts_cleanly(text: str) -> bool:
    toks = tokens(text)
    return bool(toks) and toks[0] not in WEAK_STARTS


def ends_cleanly(text: str) -> bool:
    return bool(SENT_END_RE.search(text.strip()))


def extract_keywords(text: str, n: int = 6) -> list[str]:
    """Distinctive words (original casing) ordered by usefulness for emphasis."""
    seen: dict[str, str] = {}
    counts: Counter[str] = Counter()
    for raw in _WORD_RE.findall(text):
        low = raw.lower().strip("'-")
        if len(low) < 4 or low in STOPWORDS or low in FILLERS:
            continue
        counts[low] += 1
        seen.setdefault(low, raw.strip("'-"))

    def weight(w: str) -> float:
        return len(w) * 0.4 + counts[w] * 1.5 + (4 if w in INTENSE_WORDS or w in HOOK_WORDS else 0) + (
            3 if any(ch.isdigit() for ch in w) else 0
        )

    ranked = sorted(counts, key=lambda w: (-weight(w), w))[:n]
    return [seen[w] for w in ranked]


def shorten(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-") + "…"
