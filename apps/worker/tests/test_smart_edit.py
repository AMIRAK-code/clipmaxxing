"""Smart Edit engine and the AI-tab settings overlay."""
from __future__ import annotations

import base64
import json
import os

import pytest

from klipz_worker import ai_settings
from klipz_worker.config import Settings
from klipz_worker.steps import smart_edit as se
from klipz_worker.steps.score import HeuristicScorer, OpenAICompatScorer, pick_scorer


def W(text: str, s: float, e: float) -> dict:
    return {"w": text, "s": s, "e": e}


# "So the secret" | 1.4 s pause | "um" (isolated) | "is 100 percent FOCUS today."
WORDS = [
    W("So", 10.0, 10.2), W("the", 10.25, 10.4), W("secret", 10.45, 10.9),
    W("um", 12.3, 12.5),
    W("is", 13.0, 13.1), W("100", 13.15, 13.5), W("percent", 13.55, 13.9), W("FOCUS", 13.95, 14.4), W("today.", 14.45, 14.9),
]


def test_keep_ranges_cuts_silence_and_isolated_filler():
    ranges = se.keep_ranges(WORDS, 9.5, 15.5)
    assert len(ranges) == 2
    (a0, a1), (b0, b1) = ranges
    assert a0 == pytest.approx(10.0 - se.KEEP_PAD) and a1 == pytest.approx(10.9 + se.KEEP_PAD)
    assert b0 == pytest.approx(13.0 - se.KEEP_PAD) and b1 == pytest.approx(14.9 + se.KEEP_PAD)
    # the "um" at 12.3 is in neither piece
    assert not any(lo <= 12.4 <= hi for lo, hi in ranges)


def test_keep_ranges_never_exceeds_clip_and_keeps_filler_inside_speech():
    words = [W("I", 1.0, 1.1), W("um", 1.12, 1.3), W("think", 1.32, 1.6)]  # no gap around the filler: not cut
    assert se.keep_ranges(words, 1.05, 1.5) == [(1.05, 1.5)]
    assert se.keep_ranges([], 3.0, 9.0) == [(3.0, 9.0)]


def test_build_edit_is_a_valid_edit_state():
    edit = se.build_edit(WORDS, 9.5, 15.5, keywords=["secret"], hook="The secret is focus", style_id="karaoke-neon")
    assert edit["version"] == 1 and edit["auto"] is True
    assert [set(p) for p in edit["video"]] == [{"id", "srcStart", "srcEnd"}] * 2
    assert all(p["srcEnd"] > p["srcStart"] for p in edit["video"])
    assert edit["captions"]["styleId"] == "karaoke-neon" and edit["captions"]["enabled"] is True
    by = {w["w"]: w for w in edit["captions"]["words"]}
    assert by["secret"].get("emph") is True          # keyword
    assert by["100"].get("emph") is True             # number
    assert by["FOCUS"].get("emph") is True           # shouted
    assert "emph" not in by["the"]
    assert by["So"]["id"] == "w0_10000"              # same id scheme as wordsToCaptionWords() in shared
    assert edit["hook"]["enabled"] is True and edit["hook"]["text"] == "The secret is focus"
    assert 1.0 <= edit["hook"]["durationSec"] <= se.HOOK_SECONDS
    assert edit["progressBar"]["enabled"] is True
    json.dumps(edit)  # plain JSON


def test_zooms_alternate_on_cuts_and_stay_sorted():
    edit = se.build_edit(WORDS, 9.5, 15.5, keywords=["secret"])
    zooms = edit["zooms"]
    assert (zooms[0]["t"], zooms[0]["scale"], zooms[0]["ease"]) == (0.0, 1.0, "linear")
    assert [z["t"] for z in zooms] == sorted(z["t"] for z in zooms)
    cut_at = edit["video"][0]["srcEnd"] - edit["video"][0]["srcStart"]
    cut = next(z for z in zooms if abs(z["t"] - cut_at) < 0.02)
    assert cut["scale"] == se.CUT_ZOOM and cut["ease"] == "snap"
    assert all(1.0 <= z["scale"] <= se.PUNCH_ZOOM for z in zooms)


def test_single_piece_without_emphasis_has_no_zoom():
    words = [W("hello", 0.0, 0.3), W("there", 0.35, 0.6)]
    assert se.build_zooms(se.keep_ranges(words, 0.0, 0.7), []) == []


def test_summary_counts():
    edit = se.build_edit(WORDS, 9.5, 15.5, keywords=["secret"])
    s = se.summary(edit, 9.5, 15.5)
    assert s["cuts"] == 1 and s["seconds_removed"] > 2 and s["emphasised_words"] == 3


# ── AI tab settings ───────────────────────────────────────────────────────
def _b(x: bytes) -> str:
    return base64.urlsafe_b64encode(x).decode().rstrip("=")


def _seal(plain: str, key: bytes) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    iv = os.urandom(12)
    out = AESGCM(key).encrypt(iv, plain.encode(), None)
    return f"v1:{_b(iv)}:{_b(out[-16:])}:{_b(out[:-16])}"


@pytest.fixture()
def clean_env(monkeypatch):
    for k in ("LLM_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
              "OLLAMA_URL", "OLLAMA_MODEL", "ELEVENLABS_API_KEY", "KLIPZ_SMART_EDIT", "TOKEN_ENCRYPTION_KEY"):
        monkeypatch.delenv(k, raising=False)


def test_effective_reads_sealed_keys_and_env_wins(tmp_path, clean_env, monkeypatch):
    key = os.urandom(32)
    (tmp_path / "secret.key").write_text(base64.b64encode(key).decode() + "\n")
    (tmp_path / "ai-settings.json").write_text(json.dumps({
        "provider": "openai", "smartEdit": False,
        "openai": {"keyEnc": _seal("sk-file", key), "baseUrl": "http://127.0.0.1:1234/v1", "model": "local-model"},
        "elevenlabs": {"keyEnc": _seal("el-file", key)},
        "ollama": {"model": "llama-from-file"},
    }))
    base = Settings(data_dir=tmp_path, llm_provider="auto", openai_api_key="", openai_model="", elevenlabs_api_key="",
                    ollama_model="", anthropic_api_key="")
    eff = ai_settings.effective(base)
    assert (eff.llm_provider, eff.openai_api_key, eff.openai_model, eff.openai_base_url) == (
        "openai", "sk-file", "local-model", "http://127.0.0.1:1234/v1")
    assert eff.elevenlabs_api_key == "el-file" and eff.smart_edit is False and eff.ollama_model == "llama-from-file"
    assert isinstance(pick_scorer(eff), OpenAICompatScorer)

    monkeypatch.setenv("OPENAI_MODEL", "from-env")
    monkeypatch.setenv("LLM_PROVIDER", "none")
    locked = ai_settings.effective(Settings(data_dir=tmp_path, llm_provider="none", openai_model="from-env", anthropic_api_key=""))
    assert locked.openai_model == "from-env" and locked.llm_provider == "none"
    assert isinstance(pick_scorer(locked), HeuristicScorer)


def test_effective_survives_missing_file_and_bad_key(tmp_path, clean_env):
    base = Settings(data_dir=tmp_path, anthropic_api_key="", openai_model="", ollama_model="")
    assert ai_settings.effective(base) is base
    (tmp_path / "secret.key").write_text(base64.b64encode(os.urandom(32)).decode())
    (tmp_path / "ai-settings.json").write_text(json.dumps({"anthropic": {"keyEnc": _seal("x", os.urandom(32))}}))
    assert ai_settings.effective(base).anthropic_api_key == ""   # wrong key: ignored, no crash
    assert isinstance(pick_scorer(ai_settings.effective(base)), HeuristicScorer)


def test_openai_compat_scorer_parses_reply():
    from klipz_worker.steps import segment as seg

    sents = seg.build_sentences([W("Why", 0, 0.2), W("does", 0.25, 0.4), W("this", 0.45, 0.6), W("work?", 0.65, 1.0)])
    cand = seg.Candidate(0.0, 1.0, sents)
    reply = {"ratings": [{"id": 0, "hook": 90, "context": 80, "emotion": 70, "payoff": 60, "title": "T",
                          "hook_line": "H", "reason": "R", "keywords": ["work"]}]}

    class Resp:
        status_code, text = 200, ""

        def raise_for_status(self) -> None: ...

        def json(self) -> dict:
            return {"choices": [{"message": {"content": json.dumps(reply)}}]}

    class Client:
        def __init__(self) -> None:
            self.calls: list = []

        def post(self, url, json=None, headers=None):
            self.calls.append((url, headers))
            return Resp()

    c = Client()
    [r] = OpenAICompatScorer("http://x/v1/", "sk", "m", client=c).rate([cand])
    assert (r.hook, r.scorer, r.title) == (90.0, "openai", "T")
    assert c.calls[0] == ("http://x/v1/chat/completions", {"authorization": "Bearer sk"})
