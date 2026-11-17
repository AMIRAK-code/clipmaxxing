from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from klipz_worker.config import Settings
from klipz_worker.db import Database
from klipz_worker.handlers import build_handlers
from klipz_worker.runner import JobContext, Runner
from klipz_worker.steps import features, segment, transcribe as tr
from klipz_worker.steps.analyze import analyze, handle_analyze
from klipz_worker.steps.score import (
    AnthropicScorer, HeuristicScorer, OllamaScorer, pick_scorer, score_candidates, validate_ratings,
)
from klipz_worker.steps.select import select_top
from tests.conftest import add_source


# ── helpers ─────────────────────────────────────────────────────────────
def make_words(sentences: list[str], start: float = 0.0, wps: float = 0.35, gap: float = 0.3) -> list[dict[str, Any]]:
    words, t = [], start
    for s in sentences:
        for tok in s.split():
            words.append({"w": tok, "s": round(t, 3), "e": round(t + wps * 0.9, 3)})
            t += wps
        t += gap
    return words


LONG_TEXT = [
    "Why do most people never finish what they start?",
    "I spent ten years getting this wrong and it cost me everything.",
    "Here is the thing nobody tells you about motivation.",
    "It fades after about three days, every single time.",
    "So you need a system, not a feeling.",
    "That is why the first rule is to make the task tiny.",
    "Write one sentence a day and you will be shocked at the result.",
    "The key is to never skip two days in a row.",
    "Anyway, um, I was kind of thinking about it the other day, you know.",
    "And like it was sort of a thing that happened, I guess.",
    "Yeah so basically it was a long afternoon and nothing much occurred.",
    "We just sat there and talked about the weather for a while.",
]


def long_words(n_repeat: int = 6) -> list[dict[str, Any]]:
    return make_words(LONG_TEXT * n_repeat)


class FakeTranscriber:
    name = "fake"

    def __init__(self, words: list[dict[str, Any]]):
        self.words, self.calls = words, 0

    def transcribe(self, audio_path: Path, duration: float, on_progress: Any) -> dict[str, Any]:
        self.calls += 1
        on_progress(0.5)
        return {"language": "en", "words": [dict(w) for w in self.words], "model": "fake:1"}


@pytest.fixture(autouse=True)
def _reset_override():
    yield
    tr.set_transcriber_override(None)


def make_ctx(settings: Settings, db: Database, project: str, payload: dict[str, Any]) -> JobContext:
    job = db.enqueue("analyze", payload, project_id=project)
    claimed = db.claim(settings.worker_id, ["analyze"])
    assert claimed and claimed["id"] == job["id"]
    return JobContext(settings, db, claimed)


# ── segmentation ────────────────────────────────────────────────────────
def test_sentences_split_on_punctuation_and_pause():
    words = make_words(["Hello there friend.", "How are you today?"])
    assert [s.text for s in segment.build_sentences(words)] == ["Hello there friend.", "How are you today?"]
    # a long pause without punctuation also splits
    w = make_words(["one two three"], gap=0) + make_words(["four five six"], start=10.0)
    assert len(segment.build_sentences(w)) == 2


def test_sentence_length_cap():
    words = [{"w": "word", "s": i * 0.5, "e": i * 0.5 + 0.4} for i in range(200)]  # 100 s no punctuation
    sents = segment.build_sentences(words)
    assert len(sents) >= 4
    assert all(s.e - s.s <= segment.MAX_SENTENCE + 1.0 for s in sents)


def test_candidates_on_sentence_boundaries_and_length():
    words = long_words()
    sents = segment.build_sentences(words)
    dur = words[-1]["e"] + 1
    cands = segment.generate_candidates(sents, dur)
    assert 3 <= len(cands) <= segment.pool_size(dur)  # the pool grows with the video
    for c in cands:
        assert segment.MIN_LEN - 1 <= c.duration <= segment.MAX_LEN + 1e-6
        first, last = c.sentences[0], c.sentences[-1]
        assert first in sents and last in sents
        # a little air around the speech, never more than half the silence to the next speech
        assert first.s - segment.PAD_START - 1e-6 <= c.start <= first.s
        assert last.e <= c.end <= last.e + segment.PAD_END + 1e-6
        i, j = sents.index(first), sents.index(last)
        if i > 0:
            assert c.start >= (sents[i - 1].e + first.s) / 2 - 1e-3
        if j + 1 < len(sents):
            assert c.end <= (last.e + sents[j + 1].s) / 2 + 1e-3
    keys = {(c.start, c.end) for c in cands}
    assert len(keys) == len(cands)


def _timed(parts: list[tuple[str, float]], start: float = 0.0) -> list[dict]:
    """Words of each (sentence, pause after it) pair, 0.4 s a word."""
    out, t = [], start
    for text, pause in parts:
        for w in text.split():
            out.append({"w": w, "s": round(t, 3), "e": round(t + 0.32, 3)})
            t += 0.4
        t += pause
    return out


def test_clips_start_at_a_sentence_start_and_end_on_a_finished_thought():
    # punctuated transcript: the 25 s cap splits the run-on second sentence mid-thought
    run_on = " ".join(["and then we kept going further"] * 14)
    parts = [("Here is the thing nobody tells you about saving money every month.", 0.3),
             (run_on, 0.1),
             ("That is the whole trick.", 0.3)] + [
             (f"Sentence number {k} explains another useful detail clearly.", 0.3) for k in range(12)]
    sents = segment.build_sentences(_timed(parts))
    start_ok, end_ok = segment.boundaries(sents)
    cut = [i for i, s in enumerate(sents) if not segment.H.ends_cleanly(s.text) and i < len(sents) - 1]
    assert cut, "the run-on sentence must have been split by the length cap"
    for i in cut:
        assert end_ok[i] is False and start_ok[i + 1] is False
    for c in segment.generate_candidates(sents, sents[-1].e + 1):
        assert segment.H.ends_cleanly(c.sentences[-1].text)
        i = sents.index(c.sentences[0])
        assert i == 0 or segment.H.ends_cleanly(sents[i - 1].text)


def test_a_clip_runs_on_to_finish_its_sentence():
    # 14 s of short sentences, then one 6 s sentence: a 15 s clip would have to stop mid-way, so the clip
    # takes the whole sentence (20 s) rather than ending before or inside it
    parts = [("One two three four five six seven.", 0.2)] * 5 + [
        ("This last sentence takes quite a while to finish because it keeps on going and going.", 2.0),
        ("Unrelated words after a long pause here.", 0.2)] + [("More words to make the video longer.", 0.2)] * 50
    sents = segment.build_sentences(_timed(parts))
    cands = segment.generate_candidates(sents, sents[-1].e + 1, max_candidates=100)
    first = [c for c in cands if c.start <= 0.0 + 1e-6]
    assert first and all(segment.H.ends_cleanly(c.sentences[-1].text) for c in first)
    assert min(c.duration for c in first) >= 15.0


def test_a_clip_does_not_end_on_a_question_that_is_answered_next():
    parts = [(f"Statement number {k} is a plain sentence.", 0.3) for k in range(6)] + [
        ("So what do you think people get wrong about this?", 0.3),
        ("Honestly they think it is easy and it is not.", 0.3)] + [
        (f"Another plain sentence number {k} follows here.", 0.3) for k in range(30)]
    sents = segment.build_sentences(_timed(parts))
    q = next(i for i, s in enumerate(sents) if s.text.endswith("?"))
    _start_ok, end_ok = segment.boundaries(sents)
    assert end_ok[q] is False and end_ok[q + 1] is True
    assert all(not c.sentences[-1].text.endswith("?") for c in segment.generate_candidates(sents, sents[-1].e + 1))
    # nobody answers (a long pause, then something else): the question may end a clip
    parts[7] = ("Honestly they think it is easy and it is not.", 0.3)
    parts[6] = ("So what do you think people get wrong about this?", 2.0)  # thinking before answering
    assert segment.boundaries(segment.build_sentences(_timed(parts)))[1][q] is False
    parts[6] = ("So what do you think people get wrong about this?", 3.5)
    sents = segment.build_sentences(_timed(parts))
    assert segment.boundaries(sents)[1][q] is True


def test_unpunctuated_transcripts_use_pauses_as_boundaries():
    words = _timed([("یک دو سه چهار پنج شش هفت هشت", 1.0)] * 12)
    sents = segment.build_sentences(words)
    start_ok, end_ok = segment.boundaries(sents)
    assert all(start_ok) and all(end_ok)
    assert segment.generate_candidates(sents, sents[-1].e + 1)


def test_persian_sentences_end_and_start_like_latin_ones():
    assert segment.H.ends_cleanly("این همان چیزی است که می‌خواستم؟")
    assert segment.H.ends_cleanly("بله.»")
    assert not segment.H.starts_cleanly("ولی بعدش فهمیدم")
    assert segment.H.starts_cleanly("راز موفقیت در سه کلمه است")
    assert segment.H.tokens("می‌خواهم بگویم") == ["می\u200cخواهم", "بگویم"]


def test_short_video_single_candidate():
    words = make_words(["Quick one."])
    cands = segment.generate_candidates(segment.build_sentences(words), 8.0)
    assert len(cands) == 1 and cands[0].start == 0.0 and cands[0].end == 8.0


# ── features ────────────────────────────────────────────────────────────
def test_features():
    energy = {"hop": 0.5, "rms": [0.1] * 20 + [0.9] * 20}
    quiet = features.window_features(energy, [], 0, 10)
    loud = features.window_features(energy, [11.0, 12.0, 13.0, 14.0, 15.0], 10, 20)
    assert 0 <= quiet["energy_score"] < loud["energy_score"] <= 100
    assert loud["cuts_per_min"] == pytest.approx(30.0)
    assert quiet["cuts_score"] == 0
    assert loud["peak"] == 0.9 and quiet["opening"] == pytest.approx(0.1)
    neutral = features.window_features(None, None, 0, 10)
    assert neutral["energy_score"] == 50 and neutral["cuts_score"] == 50


# ── scoring ─────────────────────────────────────────────────────────────
def _cand(sentences: list[str], start: float = 0.0) -> segment.Candidate:
    words = make_words(sentences, start=start)
    sents = segment.build_sentences(words)
    return segment.Candidate(sents[0].s, sents[-1].e, sents)


def test_heuristic_prefers_hook_over_rambling():
    strong = _cand(["Why do most people never finish what they start?", "The secret is to make the task tiny.",
                    "That is why it works every time."])
    rambling = _cand(["And um so yeah I was like thinking about the other day you know.",
                      "It was kind of a thing I guess.", "Anyway we sort of talked for a while and then"])
    scored = score_candidates([rambling, strong], HeuristicScorer(), None, None)
    assert scored[1].score > scored[0].score
    assert all(0 <= s.score <= 100 for s in scored)
    b = scored[1].breakdown
    assert set(b) >= {"hook", "context", "emotion", "payoff", "llm", "energy", "cuts", "scorer", "keywords"}
    assert b["scorer"] == "heuristic" and len(scored[1].title) <= 60 and len(scored[1].hook) <= 80


def test_final_score_formula():
    c = _cand(["Why does this matter so much?", "Because it changes everything."])
    energy = {"hop": 0.5, "rms": [1.0] * 100}
    s = score_candidates([c], HeuristicScorer(), energy, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0])[0]
    r = s.rating
    llm = 0.35 * r.hook + 0.2 * r.context + 0.2 * r.emotion + 0.25 * r.payoff
    f = features.window_features(energy, [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0], c.start, c.end)
    # what is said (60 %) + how it is delivered: audio hype and text hype (30 %) + pacing (10 %)
    from klipz_worker.steps.score import text_hype

    wps = sum(len(x.words) for x in c.sentences) / c.duration
    hype = 0.6 * f["audio_hype"] + 0.4 * text_hype(c, wps)
    assert s.breakdown["hype"] == pytest.approx(hype, abs=0.06)
    assert s.score == pytest.approx(0.6 * llm + 0.3 * hype + 0.1 * f["cuts_score"], abs=0.05)


def test_validate_ratings_clamps_and_rejects():
    c = _cand(["Why does this matter so much?", "Because it changes everything for everybody."])
    raw = {"ratings": [
        {"id": 0, "hook": 250, "context": -5, "emotion": "abc", "payoff": 70.5, "title": "T" * 200,
         "hook_line": "H" * 200, "reason": 5, "keywords": ["everything", "BOGUS", "matter", "matter", 3, "two words"]},
        {"id": 7, "hook": 1, "context": 1, "emotion": 1, "payoff": 1},       # out of range id
        {"id": 0, "hook": 1, "context": 1, "emotion": 1, "payoff": 1},       # duplicate
        "garbage",
        {"id": 0},                                                          # missing fields (dup anyway)
    ]}
    got = validate_ratings(raw, [c], "x")
    assert list(got) == [0]
    r = got[0]
    assert (r.hook, r.context, r.emotion, r.payoff) == (100, 0, 0, 70.5)
    assert len(r.title) <= 60 and len(r.hook_line) <= 80 and r.reason
    assert "BOGUS" not in r.keywords and 3 <= len(r.keywords) <= 8
    assert validate_ratings("nope", [c], "x") == {}


class FakeAnthropic:
    def __init__(self, text: str | Exception):
        self.text, self.calls = text, []
        self.messages = SimpleNamespace(create=self._create)

    def _create(self, **kw: Any) -> Any:
        self.calls.append(kw)
        if isinstance(self.text, Exception):
            raise self.text
        return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=self.text)])


def test_anthropic_scorer_valid_and_fallback():
    cands = [_cand(["Why does this matter so much?", "Because it changes everything."]),
             _cand(["Here is another point about something."], 50.0)]
    ok = json.dumps({"ratings": [
        {"id": 0, "hook": 90, "context": 80, "emotion": 70, "payoff": 60, "title": "Big title", "hook_line": "Hook!",
         "reason": "Because.", "keywords": ["matter", "everything", "changes"]},
        # id 1 missing -> heuristic for that one
    ]})
    client = FakeAnthropic(ok)
    sc = AnthropicScorer("k", "claude-opus-5-5", client=client)
    out = sc.rate(cands)
    assert out[0].scorer == "anthropic" and out[0].hook == 90 and out[0].title == "Big title"
    assert out[1].scorer == "heuristic"
    kw = client.calls[0]
    assert kw["model"] == "claude-opus-5-5" and "output_config" in kw and "[0.0]" in kw["messages"][0]["content"]

    for bad in (RuntimeError("boom"), "not json at all", json.dumps({"ratings": "x"})):
        out = AnthropicScorer("k", "m", client=FakeAnthropic(bad)).rate(cands)
        assert [r.scorer for r in out] == ["heuristic", "heuristic"]
    # whole-pipeline: scorer that raises entirely still yields scores
    class Boom:
        name = "boom"

        def rate(self, c: Any) -> Any:
            raise RuntimeError("x")

    assert len(score_candidates(cands, Boom(), None, None)) == 2


def test_ollama_scorer_uses_chat_endpoint():
    cands = [_cand(["Why does this matter so much?", "Because it changes everything."])]
    seen: dict[str, Any] = {}

    class Client:
        def post(self, url: str, json: Any) -> Any:  # noqa: A002
            seen["url"], seen["body"] = url, json
            content = {"ratings": [{"id": 0, "hook": 55, "context": 55, "emotion": 55, "payoff": 55, "title": "t",
                                    "hook_line": "h", "reason": "r", "keywords": []}]}
            return SimpleNamespace(raise_for_status=lambda: None,
                                   json=lambda: {"message": {"content": __import__("json").dumps(content)}})

    out = OllamaScorer("http://x:1/", "llama", client=Client()).rate(cands)
    assert out[0].scorer == "ollama" and out[0].hook == 55
    assert seen["url"] == "http://x:1/api/chat" and seen["body"]["format"]["type"] == "object"


def test_pick_scorer(settings: Settings):
    settings.anthropic_api_key, settings.ollama_model, settings.llm_provider = "", "", "auto"
    assert pick_scorer(settings).name == "heuristic"
    settings.ollama_model = "llama3"
    assert pick_scorer(settings).name == "ollama"
    settings.anthropic_api_key = "sk-test"
    assert pick_scorer(settings).name == "anthropic"
    settings.llm_provider = "none"
    assert pick_scorer(settings).name == "heuristic"


# ── selection ───────────────────────────────────────────────────────────
def test_select_non_overlapping_sorted():
    mk = lambda s, e, sc: SimpleNamespace(start=s, end=e, score=sc)  # noqa: E731
    items = [mk(0, 30, 90), mk(5, 35, 95), mk(28, 60, 80), mk(100, 130, 70), mk(125, 160, 99), mk(200, 230, 10)]
    out = select_top(items, max_clips=4)
    assert [i.score for i in out] == sorted((i.score for i in out), reverse=True)
    for a in out:
        for b in out:
            if a is not b:
                inter = max(0, min(a.end, b.end) - max(a.start, b.start))
                assert inter <= 0.10 * min(a.end - a.start, b.end - b.start) + 1e-9
    assert len(select_top(items, max_clips=2)) == 2


# ── transcription ───────────────────────────────────────────────────────
def test_transcribe_persist_and_idempotent(settings, db, project, sample_video):
    sid = add_source(db, settings, project, sample_video)
    fake = FakeTranscriber(make_words(["Hello world.", "This is a test of things."]))
    tr.set_transcriber_override(fake)
    ctx = make_ctx(settings, db, project, {"source_video_id": sid})
    out = tr.handle_transcribe(ctx)
    assert out["words"] == 8 and out["language"] == "en"
    row = db.one("transcripts", "select * from transcripts where source_video_id = ?", sid)
    assert row and len(row["words"]) == 8 and row["speakers"] == ["S1"] and row["model"] == "fake:1"
    assert all(w["spk"] == "S1" for w in row["words"]) and len(row["segments"]) == 2
    tr.handle_transcribe(ctx)
    assert fake.calls == 1
    assert len(db.many("transcripts", "select * from transcripts")) == 1
    ctx.payload["force"] = True
    tr.handle_transcribe(ctx)
    assert fake.calls == 2 and len(db.many("transcripts", "select * from transcripts")) == 1


def test_faster_whisper_falls_back_to_cpu(monkeypatch, tmp_path):
    t = tr.FasterWhisperTranscriber("tiny", "auto")
    calls: list[tuple[str, str]] = []

    def fake_load(device: str, ctype: str) -> str:
        calls.append((device, ctype))
        if device == "cuda":
            raise RuntimeError("no cuda")
        return "model"

    monkeypatch.setattr(t, "_load", fake_load)
    # the audio is decoded once by our own ffmpeg (not PyAV) and passed to the model as samples
    import numpy as np
    from klipz_worker import ffmpeg as ff

    seen: list = []
    monkeypatch.setattr(ff, "decode_mono_16k", lambda p: np.zeros(16000, dtype=np.float32))
    monkeypatch.setattr(t, "_run", lambda m, a, d, p: seen.append(a) or {"language": "en", "words": [], "model": "x"})
    assert t.transcribe(tmp_path / "a.wav", 1.0, lambda p: None)["model"] == "x"
    assert calls == [("cuda", "float16"), ("cpu", "int8")]
    assert isinstance(seen[0], np.ndarray) and seen[0].dtype == np.float32


# ── full analyze ────────────────────────────────────────────────────────
def prepared_source(settings, db, project, sample_video, duration: float) -> str:
    sid = add_source(db, settings, project, sample_video)
    ctx = make_ctx(settings, db, project, {"source_video_id": sid})
    from klipz_worker.steps.ingest import ingest

    ingest(ctx, sid)
    n = int(duration / 0.5)
    db.update("source_videos", sid, {
        "duration_sec": duration,
        "energy": {"hop": 0.5, "rms": [0.3 + 0.5 * ((i // 20) % 2) for i in range(n)]},
        "scene_cuts": [float(x) for x in range(5, int(duration), 17)],
    })
    return sid


def test_thumbnail_written(settings, db, project, sample_video):
    sid = add_source(db, settings, project, sample_video)
    from klipz_worker.steps.ingest import ingest

    ingest(make_ctx(settings, db, project, {"source_video_id": sid}), sid)
    assert settings.storage_path(f"sources/{sid}/thumb.jpg").stat().st_size > 500


def test_analyze_short_sample(settings, db, project, sample_video):
    sid = add_source(db, settings, project, sample_video)
    tr.set_transcriber_override(FakeTranscriber(make_words(["Why is this video so short?", "Nobody knows."])))
    res = handle_analyze(make_ctx(settings, db, project, {"source_video_id": sid}))
    assert res["clips_created"] == 1
    clip = db.many("clips", "select * from clips")[0]
    assert clip["start_sec"] == 0 and clip["end_sec"] == pytest.approx(12.0, abs=0.5)


def test_analyze_full_flow(settings, db, project, sample_video):
    settings.llm_provider, settings.anthropic_api_key, settings.ollama_model = "none", "", ""
    sid = prepared_source(settings, db, project, sample_video, 500.0)
    fake = FakeTranscriber(long_words(8))
    tr.set_transcriber_override(fake)
    ctx = make_ctx(settings, db, project, {"source_video_id": sid, "max_clips": 5})
    res = handle_analyze(ctx)
    clips = db.many("clips", "select * from clips where source_video_id = ?", sid)
    assert res["clips_created"] == len(clips) and 2 <= len(clips) <= 5
    scores = [c["score"] for c in sorted(clips, key=lambda c: -c["score"])]
    assert scores == sorted(scores, reverse=True)
    for c in clips:
        assert c["status"] == "candidate" and c["caption_style_id"] == "bold-outline"
        assert c["crop_track"] is None
        # Smart Edit is on by default: every new clip gets an automatic edit inside its own range, version 0
        edit = c["edit_state"]
        assert edit["version"] == 1 and int(c["edit_version"] or 0) == 0
        assert all(c["start_sec"] - 1e-6 <= p["srcStart"] < p["srcEnd"] <= c["end_sec"] + 1e-6 for p in edit["video"])
        assert edit["captions"]["words"] and edit["progressBar"]["enabled"] is True
        assert 15 - 1 <= c["end_sec"] - c["start_sec"] <= 91 and c["title"] and c["hook"] and c["reason"]
        assert c["score_breakdown"]["scorer"] == "heuristic" and "keywords" in c["score_breakdown"]
    for a in clips:
        for b in clips:
            if a is not b:
                inter = max(0, min(a["end_sec"], b["end_sec"]) - max(a["start_sec"], b["start_sec"]))
                assert inter <= 0.10 * min(a["end_sec"] - a["start_sec"], b["end_sec"] - b["start_sec"]) + 1e-9

    # re-run without force: no-op
    again = handle_analyze(make_ctx(settings, db, project, {"source_video_id": sid}))
    assert again["clips_created"] == 0 and again.get("skipped")
    assert len(db.many("clips", "select * from clips")) == len(clips)
    assert fake.calls == 1

    # force: keep 'kept' and edited, replace the rest, no heavy overlap with kept
    by_score = sorted(clips, key=lambda c: -c["score"])
    kept, edited = by_score[0], by_score[1]
    db.update("clips", kept["id"], {"status": "kept"})
    db.update("clips", edited["id"], {"edit_state": {"v": 1}})
    handle_analyze(make_ctx(settings, db, project, {"source_video_id": sid, "force": True, "max_clips": 5}))
    after = db.many("clips", "select * from clips where source_video_id = ?", sid)
    ids = {c["id"] for c in after}
    assert kept["id"] in ids and edited["id"] in ids
    new = [c for c in after if c["id"] not in (kept["id"], edited["id"])]
    assert new and all(c["id"] not in {x["id"] for x in by_score[2:]} for c in after)
    for n in new:
        for p in (kept, edited):
            inter = max(0, min(n["end_sec"], p["end_sec"]) - max(n["start_sec"], p["start_sec"]))
            assert inter / min(n["end_sec"] - n["start_sec"], p["end_sec"] - p["start_sec"]) <= 0.5 + 1e-9
    assert fake.calls == 1  # transcript reused


def test_handlers_registered_and_runner_executes_analyze(settings, db, project, sample_video):
    h = build_handlers()
    assert {"import_youtube", "ingest", "transcribe", "analyze"} <= set(h)
    sid = add_source(db, settings, project, sample_video)
    tr.set_transcriber_override(FakeTranscriber(make_words(["Short and sweet."])))
    job = db.enqueue("analyze", {"source_video_id": sid}, project_id=project)
    assert Runner(settings, h, db).run_once()
    j = db.get("jobs", job["id"])
    assert j["status"] == "succeeded" and j["result"]["clips_created"] == 1


def test_health_api(settings, db):
    from fastapi.testclient import TestClient

    from klipz_worker.main import create_app

    r = Runner(settings, build_handlers(), db)
    body = TestClient(create_app(r)).get("/health").json()
    assert body["ok"] and body["worker_id"] == "test-worker" and "analyze" in body["handlers"]
    assert body["current_job"] is None


def test_handle_analyze_bad_max_clips_is_permanent(settings, db, project, sample_video):
    from klipz_worker.runner import PermanentError

    sid = add_source(db, settings, project, sample_video)
    with pytest.raises(PermanentError):
        handle_analyze(make_ctx(settings, db, project, {"source_video_id": sid, "max_clips": "abc"}))


def test_validate_ratings_rejects_bool_id():
    cands = segment.generate_candidates(segment.build_sentences(long_words()), 600.0)
    raw = {"ratings": [{"id": True, "hook": 1, "context": 1, "emotion": 1, "payoff": 1}]}
    assert validate_ratings(raw, cands, "x") == {}
