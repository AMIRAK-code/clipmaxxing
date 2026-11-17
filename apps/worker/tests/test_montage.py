"""Montage: scenes from several uploads -> short vertical mixes (steps/montage.py)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from klipz_worker import ffmpeg
from klipz_worker.config import Settings
from klipz_worker.fastrender import model as fast_model
from klipz_worker.db import Database
from klipz_worker.handlers import build_handlers
from klipz_worker.reframe.detect import Face, NoFaceDetector
from klipz_worker.runner import JobContext
from klipz_worker.steps import montage as M
from klipz_worker.steps import render as render_step
from klipz_worker.steps import transcribe as tr
from klipz_worker.steps.features import AudioProfile
from tests.conftest import add_source

FIXTURE = Path(__file__).with_name("fixtures") / "montage_assembly.json"


@pytest.fixture(autouse=True)
def _reset_override():
    yield
    tr.set_transcriber_override(None)


# ── the shared random generator and the assembly ──────────────────────────
def test_generator_matches_mulberry32_in_typescript():
    # reference values from JavaScript's mulberry32 (server/montage.ts uses the same)
    expected = {1: [0.627073940588161, 0.002735721180215, 0.527447039959952, 0.981050967471674],
                42: [0.601103751920164, 0.448290558997542, 0.852465793490410, 0.669734041439369],
                2147483646: [0.993644358590245, 0.381089897360653, 0.379530817735940, 0.998798680026084]}
    for seed, vals in expected.items():
        r = M.Rng(seed)
        assert [round(r.next(), 15) for _ in vals] == pytest.approx(vals, abs=1e-14)


SCENES = [
    {"id": "a1", "input": "A", "start": 1.0, "end": 4.0, "score": 80},
    {"id": "a2", "input": "A", "start": 7.0, "end": 9.5, "score": 60},
    {"id": "a3", "input": "A", "start": 12.0, "end": 16.0, "score": 40},
    {"id": "b1", "input": "B", "start": 18.0, "end": 21.0, "score": 90},
    {"id": "b2", "input": "B", "start": 23.0, "end": 27.5, "score": 30},
    {"id": "c1", "input": "C", "start": 29.0, "end": 31.5, "score": 70},
    {"id": "c2", "input": "C", "start": 33.0, "end": 36.0, "score": 50},
]


def test_assembly_fills_the_length_range_and_alternates_uploads():
    mixes = M.assemble_montages(SCENES, 6, 10.0, 20.0, seed=7)
    assert len(mixes) == 6
    by = {s["id"]: s for s in SCENES}
    for pieces in mixes:
        total = sum(p["srcEnd"] - p["srcStart"] for p in pieces)
        assert 10.0 - 0.05 <= total <= 20.0 + 1e-6
        inputs = [by[p["sceneId"]]["input"] for p in pieces]
        assert all(a != b for a, b in zip(inputs, inputs[1:]))  # never the same upload twice in a row
        assert len({p["sceneId"] for p in pieces}) == len(pieces)  # a scene at most once per montage
        for p in pieces:
            s = by[p["sceneId"]]
            assert s["start"] == p["srcStart"] and p["srcEnd"] <= s["end"]
    # every scene is used before any is used a third time
    counts: dict[str, int] = {}
    for pieces in mixes:
        for p in pieces:
            counts[p["sceneId"]] = counts.get(p["sceneId"], 0) + 1
    assert set(counts) == set(by) and max(counts.values()) - min(counts.values()) <= 2


def test_assembly_is_reproducible_and_trims_the_last_scene_only_when_nothing_fits():
    assert M.assemble_montages(SCENES, 3, 10, 20, seed=99) == M.assemble_montages(SCENES, 3, 10, 20, seed=99)
    assert M.assemble_montages(SCENES, 3, 10, 20, seed=99) != M.assemble_montages(SCENES, 3, 10, 20, seed=100)
    long_only = [{"id": "x", "input": "A", "start": 0.0, "end": 5.0, "score": 1}, {"id": "y", "input": "B", "start": 9.0, "end": 14.0, "score": 1}]
    [pieces] = M.assemble_montages(long_only, 1, 6.0, 7.0, seed=3)
    assert sum(p["srcEnd"] - p["srcStart"] for p in pieces) == pytest.approx(7.0, abs=0.01)
    assert len(pieces) == 2 and pieces[1]["srcEnd"] - pieces[1]["srcStart"] == pytest.approx(2.0, abs=0.01)


def test_assembly_never_overshoots_the_maximum_for_any_seed():
    for seed in range(1, 200):
        for lo, hi in ((6, 9), (10, 20), (5, 5.5)):
            for pieces in M.assemble_montages(SCENES, 4, lo, hi, seed=seed):
                total = sum(p["srcEnd"] - p["srcStart"] for p in pieces)
                assert total <= hi + 1e-6, (seed, lo, hi, pieces)
                assert all(p["srcEnd"] - p["srcStart"] >= M.MIN_TRIMMED - 1e-6 for p in pieces)


def test_assembly_matches_the_typescript_fixture():
    """server/montage.test.ts checks its assembleMontages() against the same file."""
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for case in cases:
        got = M.assemble_montages(case["scenes"], case["count"], case["minSec"], case["maxSec"], case["seed"], case.get("usage"))
        assert got == case["expected"], case["name"]


# ── scoring and scenes ────────────────────────────────────────────────────
def _energy(duration: float, loud: tuple[float, float]) -> dict[str, Any]:
    n = int(duration / 0.5)
    rms = [0.75 if loud[0] <= i * 0.5 < loud[1] else 0.15 for i in range(n)]
    return {"v": 2, "hop": 0.5, "rms": rms, "bright": [0.5] * n, "flux": [0.5] * n}


def test_loud_moving_parts_score_highest_and_become_2_to_5_s_scenes():
    duration = 40.0
    profile = AudioProfile(_energy(duration, (20.0, 26.0)))
    motion = [(t / 4, 0.3 if 21 <= t / 4 < 24 else 0.02) for t in range(int(duration * 4))]
    moments = M.score_moments(duration, profile, motion, [])
    best = max(moments, key=lambda m: m.score)
    assert 19.0 <= best.t <= 24.0
    scenes = M.find_scenes(duration, moments, [], cuts=[22.3], limit=5)
    assert scenes and 19.0 <= scenes[0].start <= 24.5
    for a in scenes:
        assert M.SCENE_MIN - 1e-6 <= a.duration <= M.SCENE_MAX + 1e-6
    ordered = sorted(scenes, key=lambda s: s.start)
    assert all(b.start - a.end >= M.MIN_GAP - 1e-6 for a, b in zip(ordered, ordered[1:]))


def test_scenes_with_speech_start_and_end_between_words():
    words = []
    t = 10.0
    for tok in "WOW that was absolutely insane! Nobody saw that coming.".split():
        words.append({"w": tok, "s": round(t, 2), "e": round(t + 0.3, 2)})
        t += 0.4
    duration = 30.0
    moments = M.score_moments(duration, AudioProfile(_energy(duration, (10.0, 14.0))), [], words)
    scenes = M.find_scenes(duration, moments, words, limit=3)
    sp = next(s for s in scenes if s.has_speech)
    starts, ends = [w["s"] for w in words], [w["e"] for w in words]
    assert any(abs(sp.start - (s - 0.1)) < 1e-6 for s in starts)          # just before a word starts
    assert any(abs(sp.end - (e + 0.15)) < 1e-6 for e in ends)             # just after a word ends
    assert sp.duration <= M.SCENE_SPEECH_MAX + 1e-6 and "insane!" in sp.text


def test_pool_gives_every_upload_its_share_and_keeps_upload_order():
    per = {"A": [M.SceneSpan(float(i * 10), float(i * 10 + 3), 90 - i, {}) for i in range(10)],
           "B": [M.SceneSpan(float(i * 10), float(i * 10 + 3), 20 - i, {}) for i in range(3)]}
    chosen = M.choose_pool(per, 8)
    assert len(chosen) == 8 and sum(1 for sid, _ in chosen if sid == "B") == 3
    assert [sid for sid, _ in chosen] == ["A"] * 5 + ["B"] * 3
    assert all(a.start < b.start for (sa, a), (sb, b) in zip(chosen, chosen[1:]) if sa == sb)
    assert M.pool_size(1) == M.POOL_MIN * 1.5 and M.pool_size(20) == M.POOL_MAX


class _FaceAt:
    def __init__(self, cx: float):
        self.cx = cx

    def detect(self, frame: Any) -> list[Face]:
        return [Face(self.cx, 0.4, 0.1, 0.2), Face(0.9, 0.5, 0.02, 0.04)]


def test_framing_follows_the_main_face_or_shows_the_whole_frame(tmp_path, sample_video):
    assert M.frame_mode(sample_video, 720, 1280, 0, 3, NoFaceDetector()) == ("fill", 0.5)   # vertical: fill
    assert M.frame_mode(sample_video, 1280, 720, 0, 3, _FaceAt(0.3)) == ("crop", pytest.approx(0.3))
    assert M.frame_mode(sample_video, 1280, 720, 0, 3, NoFaceDetector()) == ("fit", 0.5)


def test_montage_edit_has_captions_off_but_ready_and_the_hook_prefilled():
    words = [{"w": "hello", "s": 1.0, "e": 1.4}, {"w": "skip", "s": 5.0, "e": 5.3}, {"w": "there", "s": 8.1, "e": 8.5}]
    edit = M.montage_edit([{"srcStart": 8.0, "srcEnd": 10.0}, {"srcStart": 0.5, "srcEnd": 2.0}], words, "Watch this")
    assert [(p["srcStart"], p["srcEnd"]) for p in edit["video"]] == [(8.0, 10.0), (0.5, 2.0)]
    assert edit["captions"]["enabled"] is False and [w["w"] for w in edit["captions"]["words"]] == ["hello", "there"]
    assert edit["hook"] == {"enabled": False, "text": "Watch this", "durationSec": 2.5}
    assert edit["zooms"] == [] and edit["progressBar"]["enabled"] is False
    json.dumps(edit)


# ── the whole job, real FFmpeg ────────────────────────────────────────────
def _make_video(path: Path, w: int, h: int, duration: float, loud: tuple[float, float], src: str) -> None:
    vol = f"volume='if(between(t,{loud[0]},{loud[1]}),0.9,0.05)':eval=frame"
    ffmpeg.run_ffmpeg([
        "-f", "lavfi", "-i", f"{src}=size={w}x{h}:rate=30:duration={duration}",
        "-f", "lavfi", "-i", f"sine=frequency=330:duration={duration}",
        "-af", vol, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path),
    ])


class _WordsByDuration:
    """Fake transcriber: a few excited words in the loud part of each upload."""

    name = "fake"

    def transcribe(self, audio_path: Path, duration: float, on_progress: Any) -> dict[str, Any]:
        on_progress(0.5)
        t0 = min(10.0, duration / 2)
        toks = "WOW this is incredible! Look at that!".split()
        return {"language": "en", "words": [{"w": w, "s": round(t0 + i * 0.4, 2), "e": round(t0 + i * 0.4 + 0.3, 2)}
                                            for i, w in enumerate(toks)], "model": "fake:1"}


def test_montage_job_builds_a_vertical_pool_and_queues_montages(tmp_path, settings: Settings, db: Database, monkeypatch):
    land, vert = tmp_path / "land.mp4", tmp_path / "vert.mp4"
    _make_video(land, 1280, 720, 24.0, (10.0, 15.0), "testsrc2")
    _make_video(vert, 720, 1280, 18.0, (4.0, 9.0), "testsrc")
    pid = db.insert("projects", {"title": "Mix", "kind": "montage", "settings": {"count": 3, "minSec": 6, "maxSec": 9, "seed": 4242}})
    a = add_source(db, settings, pid, land)
    b = add_source(db, settings, pid, vert)
    tr.set_transcriber_override(_WordsByDuration())
    assert "montage" in build_handlers()
    job = db.enqueue("montage", {"project_id": pid}, project_id=pid)
    claimed = db.claim(settings.worker_id, ["montage"])
    assert claimed and claimed["id"] == job["id"]
    ctx = JobContext(settings, db, claimed)
    res = M.montage(ctx, pid, detector=NoFaceDetector())
    assert res["created"] == 3

    pool = db.get("source_videos", res["pool_source_id"])
    assert pool["role"] == "pool" and pool["status"] == "ready" and (pool["width"], pool["height"], pool["fps"]) == (1080, 1920, 30)
    info = ffmpeg.probe(settings.storage_path(pool["storage_key"]))
    assert (info["width"], info["height"], info["video_codec"], info["audio_codec"]) == (1080, 1920, "h264", "aac")
    scenes = db.many("montage_scenes", "select * from montage_scenes where project_id = ? order by idx", pid)
    assert {s["input_source_id"] for s in scenes} == {a, b}                       # both uploads contribute
    assert scenes[-1]["pool_max"] == pytest.approx(pool["duration_sec"], abs=0.01)  # scenes tile the pool exactly
    assert info["duration"] == pytest.approx(pool["duration_sec"], abs=0.1)
    for prev, s in zip([None, *scenes], scenes):
        assert s["pool_min"] <= s["pool_start"] < s["pool_end"] <= s["pool_max"]
        assert M.SCENE_MIN - 0.05 <= s["pool_end"] - s["pool_start"] <= M.SCENE_SPEECH_MAX + 0.05
        assert prev is None or s["pool_min"] == pytest.approx(prev["pool_max"], abs=1e-3)
        assert s["thumb_key"] and settings.storage_path(s["thumb_key"]).exists()
    words = db.one("transcripts", "select * from transcripts where source_video_id = ?", pool["id"])["words"]
    assert all(0 <= w["s"] < w["e"] <= pool["duration_sec"] + 1e-6 for w in words)

    clips = db.many("clips", "select * from clips where project_id = ?", pid)
    assert len(clips) == 3
    for c in clips:
        edit = c["edit_state"]
        assert c["source_video_id"] == pool["id"] and c["crop_track"]["srcW"] == 1080
        assert edit["captions"]["enabled"] is False
        total = sum(p["srcEnd"] - p["srcStart"] for p in edit["video"])
        assert total <= 9.0 + 1e-6
        for p in edit["video"]:
            assert any(s["pool_start"] - 1e-3 <= p["srcStart"] and p["srcEnd"] <= s["pool_end"] + 1e-3 for s in scenes)
    renders = db.many("renders", "select * from renders")
    assert len(renders) == 3 and all(r["status"] == "queued" for r in renders)
    assert len([j for j in db.many("jobs", "select * from jobs where type = 'render'")]) == 3
    # running it again makes nothing new (idempotent)
    assert M.montage(ctx, pid, detector=NoFaceDetector())["created"] == 0
    assert db.get("projects", pid)["settings"]["seed"]

    # a montage renders with the fast renderer (its pieces jump back and forth in the pool)
    def no_remotion(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("a montage must be drawn by the fast renderer")

    monkeypatch.setattr(render_step, "run_remotion", no_remotion)
    rid = renders[0]["id"]
    rctx = JobContext(settings, db, db.claim(settings.worker_id, ["render"]))
    render_step.render_clip(rctx, rid)
    row = db.get("renders", rid)
    assert row["status"] == "ready" and row["options"]["rendered_by"] == "fast"
    clip = db.get("clips", row["clip_id"])
    frames = sum(n for _f, n in fast_model.piece_frames(clip["edit_state"]["video"]))
    assert row["duration_sec"] == pytest.approx(frames / 30, abs=0.1) and (row["width"], row["height"]) == (1080, 1920)
