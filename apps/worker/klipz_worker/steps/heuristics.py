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
# The same signals in the other languages people most often clip (Italian, Spanish, French, German,
# Portuguese). Kept small on purpose: these are cues, not dictionaries.
HOOK_WORDS |= {
    "segreto", "mai", "nessuno", "tutti", "errore", "errori", "verità", "peggiore", "migliore", "immagina", "perché",
    "come", "sbagliato", "mito", "assurdo", "pazzesco", "incredibile", "facile", "gratis", "trucco", "lezione",
    "attenzione", "vero", "motivo", "sempre", "problema", "primo", "unico", "tu",
    "secreto", "nunca", "nadie", "todos", "verdad", "peor", "mejor", "imagina", "increíble", "fácil", "truco",
    "lección", "cuidado", "razón", "siempre", "primero", "único", "tú",
    "jamais", "personne", "erreur", "vérité", "pire", "meilleur", "imaginez", "pourquoi", "comment",
    "incroyable", "gratuit", "astuce", "leçon", "raison", "toujours", "premier", "seul",
    "geheimnis", "niemals", "niemand", "jeder", "fehler", "wahrheit", "schlimmste", "beste", "warum", "wie",
    "unglaublich", "einfach", "kostenlos", "trick", "lektion", "achtung", "grund", "immer", "erste", "einzige",
    "segredo", "ninguém", "erro", "verdade", "pior", "melhor", "imagine", "incrível", "truque",
    "lição", "razão", "primeiro", "você",
}
INTERROGATIVES |= {
    "perché", "come", "cosa", "chi", "quando", "sai", "hai", "sapevi", "qué", "cómo", "quién", "cuándo", "sabes",
    "sabías", "pourquoi", "comment", "qui", "quand", "savez", "saviez", "warum", "wie", "wer", "wann", "weißt",
    "wusstest", "como", "quem", "sabe", "sabia",
}
INTENSE_WORDS |= {
    "incredibile", "pazzesco", "assurdo", "terribile", "bellissimo", "odio", "amo", "enorme", "disastro",
    "fantastico", "orribile", "impossibile", "ridicolo", "assolutamente", "completamente", "letteralmente",
    "increíble", "loco", "desastre", "fantástico", "imposible", "ridículo", "absolutamente", "literalmente",
    "incroyable", "fou", "énorme", "désastre", "fantastique", "ridicule", "absolument", "complètement", "littéralement",
    "unglaublich", "verrückt", "schrecklich", "riesig", "katastrophe", "fantastisch", "furchtbar", "unmöglich",
    "lächerlich", "absolut", "komplett", "buchstäblich", "wahnsinn",
    "incrível", "louco", "terrível", "horrível", "impossível",
}
FILLERS |= {"ehm", "eh", "cioè", "tipo", "praticamente", "insomma", "boh", "este", "pues", "osea", "euh", "ben",
            "bah", "genre", "äh", "ähm", "halt", "né", "então"}
WEAK_STARTS |= {"e", "ma", "quindi", "allora", "perché", "anche", "poi", "però", "cioè", "beh", "y", "pero",
                "entonces", "porque", "también", "luego", "bueno", "pues", "et", "mais", "donc", "alors", "parce",
                "aussi", "puis", "ben", "und", "aber", "weil", "dann", "auch", "mas", "então", "também", "depois", "bom"}
CONCLUSION_PHRASES += (
    "ecco perché", "il punto è", "alla fine", "la lezione", "ricorda", "ed è così", "il risultato",
    "por eso", "al final", "la lección", "recuerda", "el resultado", "voilà pourquoi", "à la fin", "la leçon",
    "le résultat", "deshalb", "am ende", "die lektion", "das ergebnis", "por isso", "no final", "a lição", "o resultado",
)

# Openers that create a curiosity gap or promise something specific. A match is a strong hook signal.
CURIOSITY_RE = re.compile(
    r"\b(?:here'?s (?:why|how|what|the thing)|this is (?:why|how|what)|you won'?t believe|nobody (?:tells|talks|knows)|"
    r"no one (?:tells|talks|knows)|the (?:real |only |one )?(?:reason|truth|secret|problem|mistake)|what (?:happened|if|nobody)|"
    r"stop (?:doing|using|saying|buying)|biggest (?:mistake|lie|problem)|i (?:lost|made|quit|spent|learned|tried|wish)|"
    r"\d+ (?:things|ways|reasons|tips|steps|mistakes|rules|signs|lessons|years|days|minutes)|number one|unpopular opinion|"
    r"hot take|let me (?:tell|show|explain)|did you know|have you ever|wait(?: until| till)?|turns out|the moment|"
    r"ecco (?:perché|come|cosa)|non (?:ci )?crederai|nessuno (?:ti dice|ne parla|lo sa)|il (?:vero )?motivo|la verità|"
    r"il segreto|l'errore più grande|lo sapevi|ti spiego|sai (?:perché|cosa|come)|ti racconto|"
    r"no vas a creer|nadie (?:te dice|habla|sabe)|la verdad|el secreto|el (?:mayor )?error|sabías que|te (?:explico|cuento)|"
    r"voici (?:pourquoi|comment)|personne ne (?:dit|parle|sait)|la vérité|le secret|la (?:vraie )?raison|saviez-vous|"
    r"niemand (?:sagt|weiß|spricht)|die wahrheit|das geheimnis|der (?:wahre )?grund|wusstest du|stell dir vor|"
    r"ninguém (?:te conta|fala|sabe)|a verdade|o segredo|o (?:maior )?erro|você sabia|vou te (?:contar|explicar))\b",
    re.I,
)
# "hi guys, welcome back": the slowest possible opening for a short clip
GREETING_RE = re.compile(
    r"^\W*(?:hi|hey|hello|what'?s up|welcome(?: back)?|good (?:morning|evening|afternoon)|ciao|salve|buongiorno|buonasera|"
    r"benvenuti|bentornati|hola|buenas|bienvenidos|bonjour|salut|bienvenue|hallo|willkommen|guten (?:tag|morgen|abend)|"
    r"olá|oi|bem-vindos)\b",
    re.I,
)
LAUGH_RE = re.compile(
    r"\b(?:a?(?:ha){2,}h?|(?:he){2,}|(?:ah){2,}|(?:ja){2,}|(?:kk){2,}|lol|lmao|rofl)\b|[\[(](?:laugh\w*|risate?|risas|rires?|lachen|risos)[\])]",
    re.I,
)
INTERJECTION_RE = re.compile(
    r"\b(?:wow|whoa|omg|oh my god|oh my gosh|no way|what the|let'?s go|holy|damn|dude|bro|insane|"
    r"mamma mia|ma dai|oddio|madonna|cavolo|caspita|dios mío|no puede ser|vamos|madre mía|ostia|"
    r"oh là là|mon dieu|putain|c'est pas vrai|oh mein gott|krass|alter|meu deus|nossa|caramba)\b",
    re.I,
)
STRETCH_RE = re.compile(r"(\w)\1{2,}")  # "sooo", "nooo", "daiii"

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


def excitement(text: str) -> float:
    """0..1: how worked-up the speech reads. Exclamations, laughter, interjections, stretched and shouted
    words, intense vocabulary. Normalised by length so a long calm passage with one "wow" stays low."""
    toks = tokens(text)
    if not toks:
        return 0.0
    marks = (
        1.0 * text.count("!")
        + 0.3 * text.count("?")
        + 2.0 * len(LAUGH_RE.findall(text))
        + 1.5 * len(INTERJECTION_RE.findall(text))
        + 1.0 * len(STRETCH_RE.findall(text))
        + 0.8 * len(re.findall(r"\b[A-ZÀ-Ý]{3,}\b", text))
        + 0.8 * sum(1 for t in toks if t in INTENSE_WORDS)
    )
    # about 1 mark per 12 words already reads as lively; 1 per 4 is as excited as speech gets
    return max(0.0, min(1.0, (marks / len(toks)) * 4.0))


def hook_strength(first_sentence: str) -> float:
    """0..100: how much does this opening line make you want to keep watching?"""
    text = first_sentence.strip()
    toks = tokens(text)
    if not toks:
        return 0.0
    score = 20.0
    if CURIOSITY_RE.search(text):
        score += 22
    if GREETING_RE.search(text):
        score -= 30
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


# words that add nothing at the start of an on-screen line
_LEAD_DROP = WEAK_STARTS | FILLERS | {"now", "look", "listen", "see", "guarda", "senti", "mira", "oye", "écoute",
                                      "regarde", "schau", "hör", "olha"}
# weak for scoring, but dropping them breaks the sentence
_LEAD_KEEP = {"it", "they", "he", "she", "this", "that", "these", "those", "tu", "tú", "you", "come", "perché", "wie",
              "warum", "como", "comment", "pourquoi"}
_HEDGE_RE = re.compile(
    r"\b(?:i think|i guess|i mean|you know(?! (?:what|why|how|that|who)\b)|kind of|sort of|basically|actually|literally|honestly|"
    r"to be honest|at the end of the day|secondo me|diciamo|praticamente|in pratica|la verdad es que|"
    r"o sea|en plan|je pense que|en fait|du coup|ich denke|eigentlich|sozusagen|na verdade|tipo assim)\b[, ]*",
    re.I,
)
_CLAUSE_RE = re.compile(r"\s*(?:[,;:]|\s[-–—]\s)\s*")
_DANGLING = WEAK_STARTS | {"the", "a", "an", "of", "to", "in", "on", "for", "with", "is", "are", "il", "la", "di", "che",
                           "el", "de", "que", "le", "der", "die", "das", "o"}


def punchy(text: str, limit: int = 60) -> str:
    """A sentence boiled down to an on-screen line of at most `limit` characters, using only its own words:
    leading filler and hedges go, then whole clauses are kept while they fit. Never ends on a dangling
    conjunction; an ellipsis marks a cut inside a clause."""
    t = re.sub(r"\s+", " ", text).strip()
    t = _HEDGE_RE.sub("", t).strip()
    words = t.split(" ")
    while len(words) > 3:
        head = words[0].strip(",.;:!?…\"'").lower()
        if head in _LEAD_DROP and head not in _LEAD_KEEP:
            words = words[1:]
        else:
            break
    t = " ".join(words).strip(" ,;:-–—")
    if not t:
        return ""
    t = t[0].upper() + t[1:]
    if len(t) <= limit:
        return t
    out = ""
    for c in (c for c in _CLAUSE_RE.split(t) if c):
        nxt = f"{out}, {c}" if out else c
        if len(nxt) > limit:
            break
        out = nxt
    if out and len(out) >= min(18, limit // 2):
        return out.rstrip(" ,;:-–—")
    cut = t[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    parts = cut.split(" ")
    while len(parts) > 2 and parts[-1].strip(",.;:").lower() in _DANGLING:
        parts.pop()
    return " ".join(parts).rstrip(" ,;:-–—") + "…"


def hook_line(sentences: list[str], keywords: list[str] | None = None, limit: int = 60) -> str:
    """The on-screen hook for a clip: its most gripping early sentence, made punchy. The words are the
    speaker's own (nothing is invented), so it works in any language and never promises what is not there."""
    if not sentences:
        return ""
    keys = {k.lower() for k in (keywords or [])}
    span = max(1, min(len(sentences), max(2, int(len(sentences) * 0.6 + 0.5))))
    best, best_score = sentences[0], -1e9
    for i, sent in enumerate(sentences[:span]):
        toks = tokens(sent)
        if len(toks) < 2:
            continue
        sc = hook_strength(sent) + 35 * intensity(sent) + 25 * excitement(sent)
        sc += 10 if any(t in keys for t in toks) else 0
        sc -= 2.5 * i                        # earlier is better when it is close
        sc -= 0.8 * max(0, len(toks) - 14)   # long sentences make poor cards
        if sc > best_score:
            best, best_score = sent, sc
    return punchy(best, limit)


def shorten(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-") + "…"
