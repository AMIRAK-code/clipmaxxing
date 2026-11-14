"""Clip finding: lengths sized to the video, more potential clips, hype scoring, hook lines, framing,
Gemini / custom providers."""
from __future__ import annotations

import dataclasses
import math
import wave
from pathlib import Path

import numpy as np
import pytest

from klipz_worker import ai_settings, ffmpeg
from klipz_worker.steps import analyze as analyze_step
from klipz_worker.steps import autoclip as autoclip_step
from klipz_worker.steps import features, segment
from klipz_worker.steps import heuristics as H
from klipz_worker.steps import reframe as reframe_step
from klipz_worker.steps.score import (GEMINI_BASE_URL, HeuristicScorer, OpenAICompatScorer, Rating, pick_scorer,
                                      score_candidates, text_hype)
from klipz_worker.steps.select import select_top

from .conftest import add_source
from .test_analyze import make_ctx


def talk(n_sentences: int, words_per: int = 9, gap: float = 0.5, t0: float = 0.0, wps: float = 3.0) -> list[dict]:
    """Synthetic speech: sentences of `words_per` words, `gap` s apart."""
    out, t = [], t0
    for s in range(n_sentences):
        for w in range(words_per):
            d = 1.0 / wps
            text = f"word{s}x{w}" + ("." if w == words_per - 1 else "")
            out.append({"w": text, "s": round(t, 3), "e": round(t + d * 0.9, 3)})
            t += d
        t += gap
    return out


# ── clip length follows the video ──────────────────────────────────────────
@pytest.mark.parametrize("duration,expected", [(45, 20), (80, 20), (120, 30), (180, 45), (240, 60), (3600, 60), (0, 60)])
def test_max_len_for(duration, expected):
    assert segment.max_len_for(duration) == expected


def test_targets_and_pool_grow_with_the_video():
    assert segment.targets_for(20) == (15.0, 20.0)
    assert segment.targets_for(37.5) == (15.0, 20.0, 30.0, 37.5)
    assert segment.targets_for(60) == (15.0, 20.0, 30.0, 45.0, 60.0)
    assert segment.pool_size(60) == 60 and segment.pool_size(600) == 100 and segment.pool_size(7200) == 240


@pytest.mark.parametrize("n_sentences,cap", [(35, 30.0), (120, 60.0)])
def test_candidates_stay_between_15_s_and_the_cap(n_sentences, cap):
    words = talk(n_sentences)
    duration = words[-1]["e"] + 1
    assert segment.max_len_for(duration) == pytest.approx(cap, abs=1.0)
    cands = segment.generate_candidates(segment.build_sentences(words), duration)
    assert len(cands) >= 8
    for c in cands:
        assert segment.MIN_LEN - 1e-6 <= c.duration <= segment.max_len_for(duration) + 1e-6
    assert max(c.duration for c in cands) > 0.8 * segment.max_len_for(duration)  # long ones are offered too
    assert min(c.duration for c in cands) < 20                                   # and short ones


def test_blind_windows_cover_a_video_without_speech():
    cands = segment.generate_candidates([], 300.0)
    assert len(cands) >= 15 and all(15 <= c.duration <= 30 for c in cands)
    assert cands[1].start < cands[0].end  # half-overlapping


def test_auto_clip_count():
    assert [analyze_step.auto_clip_count(d) for d in (30, 200, 600, 1000, 7200)] == [10, 10, 30, 50, 50]


def test_select_top_second_pass_respects_taken():
    @dataclasses.dataclass
    class S:
        start: float
        end: float
        score: float

    a, b, c = S(0, 30, 90), S(20, 50, 80), S(100, 130, 70)   # b shares a third with a
    first = select_top([a, b, c], 5)
    assert first == [a, c]
    assert select_top([b], 5, 0.34, taken=first) == [b]
    assert select_top([S(5, 30, 60)], 5, 0.34, taken=first) == []


# ── audio features ─────────────────────────────────────────────────────────
def _wav(path: Path, samples: np.ndarray, sr: int = 16000) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    return path


def test_audio_energy_v2_hears_brightness_and_change(tmp_path: Path):
    sr = 16000
    t = np.arange(sr * 10) / sr
    calm = 0.2 * np.sin(2 * math.pi * 180 * t)                                   # low, steady
    rng = np.random.default_rng(1)
    wild = 0.6 * rng.standard_normal(sr * 10) * (0.5 + 0.5 * np.sign(np.sin(2 * math.pi * 3 * t)))  # bright, bursty
    e = ffmpeg.audio_energy(_wav(tmp_path / "a.wav", np.concatenate([calm, wild])))
    assert e["v"] == ffmpeg.ENERGY_VERSION and len(e["rms"]) == len(e["bright"]) == len(e["flux"]) == 40
    assert all(0 <= x <= 1 for k in ("rms", "bright", "flux") for x in e[k])
    assert np.mean(e["bright"][20:]) > np.mean(e["bright"][:20]) + 0.3
    assert np.mean(e["flux"][20:]) > np.mean(e["flux"][:20]) + 0.2
    assert ffmpeg.audio_energy(_wav(tmp_path / "s.wav", np.zeros(100)))["rms"] == []


def test_hype_is_relative_to_the_video():
    calm, loud = [0.3] * 60, [0.9] * 20
    energy = {"v": 2, "hop": 0.5, "rms": calm + loud + calm, "bright": [0.2] * 60 + [0.8] * 20 + [0.2] * 60,
              "flux": [0.2] * 60 + [0.7] * 20 + [0.2] * 60}
    p = features.AudioProfile(energy)
    quiet, hot = p.hype(0, 10), p.hype(30, 40)
    assert hot["score"] > quiet["score"] + 25 and hot["bursts"] == 100 and quiet["bursts"] == 0
    assert hot["bright"] > quiet["bright"] and hot["flux"] > quiet["flux"]
    # an evenly loud video is not "hype" anywhere: loudness alone does not win
    flat = features.AudioProfile({"hop": 0.5, "rms": [0.95] * 100})
    assert flat.hype(0, 20)["score"] < 40 and flat.hype(0, 20)["score"] == flat.hype(20, 40)["score"]
    assert features.AudioProfile(None).hype(0, 10) is None
    f = features.window_features(None, None, 0, 10)
    assert f["audio_hype"] == 50 and f["has_audio_hype"] == 0
    # v1 energy (no bright / flux) still scores
    assert features.AudioProfile({"hop": 0.5, "rms": calm + loud}).hype(30, 40)["score"] > 60


def test_build_and_opening():
    rising = features.AudioProfile({"hop": 0.5, "rms": [0.2] * 20 + [0.9] * 20})
    assert rising.hype(0, 20)["build"] > 90 and rising.hype(0, 20)["opening"] < rising.hype(10, 20)["opening"]


# ── text signals ───────────────────────────────────────────────────────────
def test_excitement_and_hooks_in_several_languages():
    assert H.excitement("WOW no way!!! hahaha that is insane") > 0.8
    assert H.excitement("The quarterly report shows a moderate increase in revenue.") == 0
    assert H.excitement("Ma dai, è pazzesco! Ahahah, incredibile!") > 0.6
    plain = H.hook_strength("It was a normal day at the office.")
    assert H.hook_strength("Here's why nobody tells you the truth about sleep.") > plain + 25
    assert H.hook_strength("Ecco perché nessuno ti dice la verità sui mutui.") > plain + 15
    assert H.hook_strength("Nadie te dice la verdad sobre el dinero.") > plain + 15
    assert H.hook_strength("Hi guys, welcome back to the channel.") < 15
    assert H.hook_strength("Ciao a tutti, benvenuti sul canale.") < 15


def test_punchy_keeps_the_speakers_words():
    assert H.punchy("So, um, I think the biggest mistake people make with money is that they never track it.") == \
        "The biggest mistake people make with money…"   # cut, and never left dangling on "is that they"
    assert H.punchy("Why do most people never finish what they start?") == "Why do most people never finish what they start?"
    assert H.punchy("And you know what, nobody tells you this about sleep!") == "You know what, nobody tells you this about sleep!"
    assert H.punchy("Allora, ecco perché nessuno ti dice la verità sui mutui, e cioè che le banche guadagnano sempre.") == \
        "Ecco perché nessuno ti dice la verità sui mutui"
    long = H.punchy("When you look at the numbers from last year and compare them with this year the difference is huge")
    assert len(long) <= 60 and long.endswith("…") and not long[:-1].rstrip().lower().endswith((" the", " and", " with"))
    for text in ("", "   ", "Um."):
        assert isinstance(H.punchy(text), str)


def test_hook_line_picks_the_gripping_sentence_not_the_greeting():
    line = H.hook_line(["Hi guys, welcome back.", "So today I lost 10,000 dollars in one day!", "It was a normal Tuesday."], ["dollars"])
    assert line == "Today I lost 10,000 dollars in one day!"
    assert H.hook_line([]) == "" and len(H.hook_line(["x " * 80])) <= 60


def test_heuristic_rating_uses_the_new_hook_line_and_reason():
    sents = segment.build_sentences([
        {"w": "Hello", "s": 0.0, "e": 0.3}, {"w": "everyone.", "s": 0.35, "e": 0.8},
        {"w": "Nobody", "s": 1.0, "e": 1.3}, {"w": "tells", "s": 1.35, "e": 1.6}, {"w": "you", "s": 1.65, "e": 1.8},
        {"w": "this", "s": 1.85, "e": 2.0}, {"w": "secret!", "s": 2.05, "e": 2.5},
        {"w": "It", "s": 16.0, "e": 16.2}, {"w": "works.", "s": 16.25, "e": 16.7},
    ])
    r = HeuristicScorer().rate([segment.Candidate(0.0, 17.0, sents)])[0]
    assert r.hook_line == "Nobody tells you this secret!" and r.reason.endswith(".") and r.reason[0].isupper()
    assert 0 <= r.hook <= 100 and r.keywords


def test_text_hype_rewards_pace_and_liveliness():
    fast = segment.Candidate(0, 15, segment.build_sentences(talk(8, wps=4.0)))
    slow = segment.Candidate(0, 30, segment.build_sentences(talk(8, wps=1.6)))
    assert text_hype(fast, 3.0) > text_hype(slow, 3.0) + 15
    assert text_hype(segment.Candidate(0, 20, []), 3.0) is None


def test_hype_changes_the_ranking_when_the_words_are_equal():
    words = talk(40)
    sents = segment.build_sentences(words)
    a = segment.Candidate(sents[0].s, sents[5].e, sents[0:6])
    b = segment.Candidate(sents[20].s, sents[25].e, sents[20:26])
    n = int(words[-1]["e"] / 0.5) + 2
    rms = [0.3] * n
    for i in range(int(b.start / 0.5), int(b.end / 0.5)):
        rms[i] = 0.95 if i % 3 else 0.5       # b is where the room gets loud
    sa, sb = score_candidates([a, b], HeuristicScorer(), {"hop": 0.5, "rms": rms}, [])
    assert sb.breakdown["hype"] > sa.breakdown["hype"] + 10 and sb.score > sa.score
    assert set(sa.breakdown) >= {"hook", "context", "emotion", "payoff", "llm", "hype", "energy", "cuts", "scorer", "keywords"}


def test_ai_scorer_only_rates_the_most_promising_windows():
    sents = segment.build_sentences(talk(60))
    cands = [segment.Candidate(sents[i].s, sents[i + 4].e, sents[i:i + 5]) for i in range(0, 50)]

    class Fake:
        name = "openai"
        seen = 0

        def rate(self, cs):
            Fake.seen = len(cs)
            return [Rating(99, 99, 99, 99, "t", "h", "r", [], "openai") for _ in cs]

    scored = score_candidates(cands, Fake(), None, None, llm_pool=12)
    assert Fake.seen == 12 and len(scored) == 50
    assert sum(1 for s in scored if s.rating.scorer == "openai") == 12


# ── providers ──────────────────────────────────────────────────────────────
def test_pick_scorer_gemini_and_custom(settings):
    base = dataclasses.replace(settings, llm_provider="auto", anthropic_api_key="", openai_model="", ollama_model="",
                               gemini_api_key="", gemini_model="", custom_base_url="", custom_model="", custom_api_key="")
    assert isinstance(pick_scorer(base), HeuristicScorer)
    g = pick_scorer(dataclasses.replace(base, gemini_api_key="k", gemini_model="models/gemini-x-flash"))
    assert isinstance(g, OpenAICompatScorer) and (g.name, g.url, g.model) == ("gemini", GEMINI_BASE_URL, "gemini-x-flash")
    assert isinstance(pick_scorer(dataclasses.replace(base, gemini_api_key="k")), HeuristicScorer)  # no model chosen yet
    c = pick_scorer(dataclasses.replace(base, custom_base_url="https://openrouter.ai/api/v1/", custom_model="m", custom_api_key="k"))
    assert (c.name, c.url, c.model, c.api_key) == ("custom", "https://openrouter.ai/api/v1", "m", "k")
    both = dataclasses.replace(base, gemini_api_key="k", gemini_model="g", custom_base_url="http://x/v1", custom_model="m")
    assert pick_scorer(both).name == "gemini"
    assert pick_scorer(dataclasses.replace(both, llm_provider="custom")).name == "custom"
    assert isinstance(pick_scorer(dataclasses.replace(both, llm_provider="none")), HeuristicScorer)


def test_ai_settings_file_fills_gemini_and_custom(tmp_path, monkeypatch):
    import base64
    import json
    import os

    from .test_smart_edit import _seal

    for k in ("LLM_PROVIDER", "GEMINI_API_KEY", "GEMINI_MODEL", "CUSTOM_AI_BASE_URL", "CUSTOM_AI_API_KEY", "CUSTOM_AI_MODEL", "TOKEN_ENCRYPTION_KEY"):
        monkeypatch.delenv(k, raising=False)
    key = os.urandom(32)
    (tmp_path / "secret.key").write_text(base64.b64encode(key).decode())
    (tmp_path / "ai-settings.json").write_text(json.dumps({
        "provider": "gemini", "gemini": {"keyEnc": _seal("g-key", key), "model": "gemini-x"},
        "custom": {"keyEnc": _seal("c-key", key), "baseUrl": "https://api.groq.com/openai/v1", "model": "llama"},
    }))
    from klipz_worker.config import Settings

    eff = ai_settings.effective(Settings(data_dir=tmp_path, llm_provider="auto", gemini_api_key="", gemini_model="",
                                         custom_api_key="", custom_base_url="", custom_model="", anthropic_api_key=""))
    assert (eff.llm_provider, eff.gemini_api_key, eff.gemini_model) == ("gemini", "g-key", "gemini-x")
    assert (eff.custom_api_key, eff.custom_base_url, eff.custom_model) == ("c-key", "https://api.groq.com/openai/v1", "llama")
    assert pick_scorer(eff).name == "gemini"


# ── framing ────────────────────────────────────────────────────────────────
def test_static_tracks():
    c = reframe_step.static_track("center", 5.0, 25.0, 1920, 1080)
    assert c == {"version": 1, "srcW": 1920, "srcH": 1080, "segments": [{"start": 5.0, "end": 25.0, "layout": "crop", "keys": [{"t": 5.0, "cx": 0.5, "cy": 0.5}]}]}
    assert reframe_step.static_track("fit", 0, 9, 1280, 720)["segments"][0]["layout"] == "letterbox"
    assert reframe_step.framing_of({}) == "speaker" and reframe_step.framing_of({"framing": "FIT"}) == "fit"
    assert reframe_step.framing_of({"framing": "weird"}) == "speaker"


@pytest.mark.parametrize("framing,layout", [("center", "crop"), ("fit", "letterbox")])
def test_reframe_without_face_tracking(db, settings, project, sample_video, framing, layout):
    sid = add_source(db, settings, project, sample_video)
    db.update("source_videos", sid, {"width": 1280, "height": 720, "duration_sec": 12.0, "status": "ready", "framing": framing})
    cid = db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": 1.0, "end_sec": 9.0, "status": "candidate"})

    class NoDetector:
        def detect(self, _frame):
            raise AssertionError("face detection must not run when the speaker focus is off")

    track = reframe_step.reframe(make_ctx(settings, db, project, {"clip_id": cid}), cid, detector=NoDetector())
    assert [s["layout"] for s in track["segments"]] == [layout]
    assert db.get("clips", cid)["crop_track"] == track
    assert db.get("source_videos", sid)["framing"] == framing


def test_new_sources_default_to_speaker_framing(db, settings, project, sample_video):
    sid = add_source(db, settings, project, sample_video)
    assert db.get("source_videos", sid)["framing"] == "speaker"


# ── AutoClip renders the best, keeps the rest ──────────────────────────────
def test_autoclip_renders_top_n_of_the_found_clips(db, settings, project, sample_video, monkeypatch):
    sid = add_source(db, settings, project, sample_video)
    db.update("source_videos", sid, {"width": 1280, "height": 720, "duration_sec": 12.0, "status": "ready"})
    ids = [db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": float(i), "end_sec": float(i) + 2, "status": "candidate",
                               "score": 90 - i, "crop_track": {"version": 1, "srcW": 1280, "srcH": 720, "segments": []}}) for i in range(6)]
    monkeypatch.setattr(autoclip_step, "analyze", lambda *_a, **_k: {"clip_ids": ids})
    res = autoclip_step.autoclip(make_ctx(settings, db, project, {"source_video_id": sid}), sid, render_clips=2)
    assert res["found"] == 6 and res["clip_ids"] == ids[:2] and len(res["render_ids"]) == 2
    rendered = {r["clip_id"] for r in db.many("renders", "select * from renders")}
    assert rendered == set(ids[:2])
    assert len(db.many("clips", "select * from clips where source_video_id = ?", sid)) == 6  # the rest stay as candidates
