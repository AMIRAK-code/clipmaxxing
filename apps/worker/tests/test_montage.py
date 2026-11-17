"""Montage: exciting scenes of several videos, mixed into short videos."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from klipz_worker import ffmpeg
from klipz_worker.reframe.detect import NoFaceDetector
from klipz_worker.runner import JobContext, PermanentError
from klipz_worker.steps import montage as mt
from klipz_worker.steps import transcribe as tr

from .conftest import add_source


def W(text: str, s: float, e: float) -> dict[str, Any]:
    return {"w": text, "s": s, "e": e}


def words_of(text: str, start: float, step: float = 0.35) -> list[dict[str, Any]]:
    return [W(t, round(start + i * step, 3), round(start + i * step + step * 0.85, 3)) for i, t in enumerate(text.split())]


# ── finding scenes ────────────────────────────────────────────────────────
def test_lively_moments_become_scenes_and_no_scene_cuts_a_word():
    calm = words_of("we sat down and talked about the weather for a while today", 1.0)
    hype = words_of("WOW no way that is INSANE!", 12.0)
    words = calm + hype + words_of("then we went home and had some dinner", 20.0)
    energy = {"hop": 0.5, "rms": [0.2] * 24 + [0.9] * 8 + [0.2] * 28}  # loud from 12 s to 16 s
    scenes = mt.find_scenes(words, energy, [5.0, 25.0], 30.0)
    assert scenes
    best = scenes[0]
    assert best.s <= 12.0 and best.e >= 12.0 + 0.35 * 5, best
    for sc in scenes:
        assert mt.SCENE_MIN - 1e-6 <= sc.duration <= mt.SCENE_MAX + mt.WORD_PAD_AFTER + mt.WORD_PAD_BEFORE + 1e-6
        for w in words:
            assert not (w["s"] < sc.s < w["e"]) and not (w["s"] < sc.e < w["e"]), (sc, w)
    for a, b in zip(scenes, scenes[1:]):
        assert a.score >= b.score
    spans = sorted((s.s, s.e) for s in scenes)
    assert all(x[1] <= y[0] for x, y in zip(spans, spans[1:]))


def test_videos_without_words_or_sound_still_give_scenes():
    scenes = mt.find_scenes([], None, [], 40.0)
    assert scenes and all(sc.kind == "action" for sc in scenes)
    burst = {"hop": 0.5, "rms": [0.1] * 40 + [0.95] * 6 + [0.1] * 34}
    scenes = mt.find_scenes([], burst, [20.5], 40.0)
    assert scenes[0].s <= 21.0 and scenes[0].e >= 21.0  # the burst at 20-23 s


# ── composing montages ────────────────────────────────────────────────────
def pool(n_videos: int = 3, per: int = 6, dur: float = 2.5) -> list[dict[str, Any]]:
    out, t = [], 0.0
    for v in range(n_videos):
        for k in range(per):
            out.append({"id": f"s{v}_{k}", "s": round(t, 3), "e": round(t + dur, 3), "from": f"vid{v}", "score": 50 + k})
            t += dur
    return out


def test_montages_fit_the_duration_range_and_mix_the_videos():
    scenes = pool()
    plans = mt.compose(scenes, 5, 10.0, 20.0, seed=1)
    assert len(plans) == 5
    by_id = {s["id"]: s for s in scenes}
    sets = set()
    for pieces in plans:
        total = sum(p["srcEnd"] - p["srcStart"] for p in pieces)
        assert 10.0 - 0.5 <= total <= 20.0 + 1e-6
        froms = [by_id[p["scene"]]["from"] for p in pieces]
        assert len(set(froms)) >= 2
        assert all(a != b for a, b in zip(froms, froms[1:])), froms
        for p in pieces:
            sc = by_id[p["scene"]]
            assert sc["s"] <= p["srcStart"] < p["srcEnd"] <= sc["e"]
        sets.add(frozenset(p["scene"] for p in pieces))
    assert len(sets) == 5  # never the same montage twice


def test_one_strong_video_does_not_take_over():
    # video 0 scores far higher than the others: montages still mix them and almost never repeat a video
    scenes = pool(4, 7)
    for sc in scenes:
        sc["score"] = 95 if sc["from"] == "vid0" else 30
    src = {s["id"]: s["from"] for s in scenes}
    back_to_back = videos = n = 0
    for seed in range(60):
        for pieces in mt.compose(scenes, 3, 10.0, 20.0, seed=seed):
            froms = [src[p["scene"]] for p in pieces]
            n += 1
            videos += len(set(froms))
            back_to_back += any(a == b for a, b in zip(froms, froms[1:]))
            assert froms.count("vid0") <= (len(froms) + 1) // 2, froms
    assert back_to_back / n < 0.05 and videos / n >= 3


def test_montage_order_is_random_and_respects_earlier_ones():
    scenes = pool()
    a = mt.compose(scenes, 1, 10, 12, seed=1)[0]
    b = mt.compose(scenes, 1, 10, 12, seed=2)[0]
    assert [p["scene"] for p in a] != [p["scene"] for p in b]
    again = mt.compose(scenes, 1, 10, 12, seed=1, avoid=[[p["scene"] for p in a]])[0]
    assert {p["scene"] for p in again} != {p["scene"] for p in a}


def test_a_long_last_scene_is_shortened_to_the_maximum():
    scenes = [{"id": "a", "s": 0.0, "e": 9.0, "from": "x", "score": 90}, {"id": "b", "s": 9.0, "e": 18.0, "from": "y", "score": 90}]
    (pieces,) = mt.compose(scenes, 1, 12.0, 12.0, seed=3)
    assert sum(p["srcEnd"] - p["srcStart"] for p in pieces) == pytest.approx(12.0)


def test_montage_edit_has_no_captions_or_hook_but_all_words():
    words = words_of("hello there", 0.0) + words_of("second scene words", 5.0)
    edit = mt.montage_edit([{"scene": "s1", "srcStart": 5.0, "srcEnd": 7.0}, {"scene": "s0", "srcStart": 0.0, "srcEnd": 2.0}], words)
    assert edit["auto"] is False
    assert [(p["srcStart"], p["srcEnd"]) for p in edit["video"]] == [(5.0, 7.0), (0.0, 2.0)]
    assert edit["captions"]["enabled"] is False and len(edit["captions"]["words"]) == 5
    assert edit["hook"]["enabled"] is False and edit["volume"] == 1
    assert len({p["id"] for p in edit["video"]}) == 2


def test_canvas_follows_the_most_common_shape():
    assert mt.canvas_for([(1920, 1080), (1280, 720), (1080, 1920)]) == (1920, 1080)
    assert mt.canvas_for([(1080, 1920), (720, 1280)]) == (1080, 1920)
    assert mt.canvas_for([(640, 360)]) == (640, 360)
    assert mt.canvas_for([(1080, 1080)]) == (1080, 1080)


def test_off_shape_videos_are_shown_whole_over_a_blurred_copy():
    parts = [(Path("a.mp4"), 1.0, 3.0, True, (1920, 1080)), (Path("b.mp4"), 0.0, 2.0, False, (720, 1280))]
    args = mt.pool_args(parts, (1280, 720), Path("out.mp4"))
    graph = args[args.index("-filter_complex") + 1]
    first, second = graph.split("[v0]")[0], graph.split("[v0]")[1]
    assert "crop=1280:720" in first and "overlay" not in first          # same shape: fills the frame
    assert "boxblur" in second and "force_original_aspect_ratio=decrease" in second and "overlay=(W-w)/2:(H-h)/2" in second
    assert "anullsrc" in graph                                          # the silent part still has a sound track


def test_pool_words_move_to_pool_time():
    scenes = [{"id": "a", "s": 0.0, "e": 2.0, "from": "x"}, {"id": "b", "s": 2.0, "e": 4.0, "from": "y"}]
    words = {"x": [W("one", 10.1, 10.5), W("outside", 13.0, 13.5)], "y": [W("two", 50.2, 50.6)]}
    out = mt.pool_words(scenes, words, {"a": (0.0, 10.0), "b": (2.0, 50.0)})
    assert [(w["w"], w["s"], w["e"]) for w in out] == [("one", 0.1, 0.5), ("two", 2.2, 2.6)]


# ── the whole job ─────────────────────────────────────────────────────────
class FakeTranscriber:
    name = "fake"

    def transcribe(self, audio_path: Path, duration: float, on_progress: Any) -> dict[str, Any]:
        return {"language": "en", "words": words_of("WOW that was AMAZING! let us go again", 6.5), "model": "fake:1"}


@pytest.fixture()
def vertical_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("media") / "vertical.mp4"
    ffmpeg.run_ffmpeg([
        "-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=30:duration=10",
        "-f", "lavfi", "-i", "sine=frequency=660:duration=10",
        "-filter_complex", "[1:a]volume='if(lt(t,4),0.05,0.9)':eval=frame[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(out),
    ])
    return out


def test_montage_job_cuts_a_scene_pool_and_makes_montages(db, settings, project, sample_video, vertical_video, monkeypatch):
    from klipz_worker.steps import reframe as rf

    tr.set_transcriber_override(FakeTranscriber())
    monkeypatch.setattr(rf, "default_detector", lambda data_dir: NoFaceDetector())
    try:
        db.update("projects", project, {"kind": "montage"})
        a = add_source(db, settings, project, sample_video)
        b = add_source(db, settings, project, vertical_video)
        ctx = JobContext(settings, db, db.enqueue("montage", {"project_id": project}, project_id=project))
        out = mt.montage(ctx, project, {"count": 3, "minSec": 4, "maxSec": 6})
    finally:
        tr.set_transcriber_override(None)

    pool = db.get("source_videos", out["pool_source_id"])
    assert pool["role"] == "pool" and pool["status"] == "ready"
    scenes = pool["scenes"]
    assert {sc["from"] for sc in scenes} == {a, b}
    info = ffmpeg.probe(settings.storage_path(pool["storage_key"]))
    assert info["has_audio"] and (info["width"], info["height"]) == (1280, 720)  # two shapes, landscape wins ties
    assert info["duration"] == pytest.approx(scenes[-1]["e"], abs=0.15)
    # the vertical video sits whole in the middle of the landscape pool, and its pieces crop the middle
    assert all(sc.get("fit") is True for sc in scenes if sc["from"] == b)
    assert not any(sc.get("fit") for sc in scenes if sc["from"] == a)
    fit_ids = {sc["id"] for sc in scenes if sc.get("fit")}
    words = db.one("transcripts", "select * from transcripts where source_video_id = ?", pool["id"])["words"]
    assert words and all(0 <= w["s"] < w["e"] <= scenes[-1]["e"] + 1e-6 for w in words)

    clips = [db.get("clips", cid) for cid in out["clip_ids"]]
    assert len(clips) == 3 and len(out["render_ids"]) == 3
    for c in clips:
        es = c["edit_state"]
        total = sum(p["srcEnd"] - p["srcStart"] for p in es["video"])
        assert total <= 6 + 1e-6 and es["captions"]["enabled"] is False
        assert c["crop_track"] is not None and c["start_sec"] == 0.0 and c["end_sec"] >= max(p["srcEnd"] for p in es["video"])
        for p in es["video"]:
            on_fit = mt._scene_at(scenes, p) in fit_ids
            assert (p.get("frame") == mt.CENTRE_CROP) == on_fit, p
    assert [c["title"] for c in clips] == ["Montage 1", "Montage 2", "Montage 3"]
    jobs = db.many("jobs", "select * from jobs where type = 'render'")
    assert len(jobs) == 3

    # "make more": same videos -> same pool, new montages numbered on
    tr.set_transcriber_override(FakeTranscriber())
    try:
        ctx = JobContext(settings, db, db.enqueue("montage", {"project_id": project}, project_id=project))
        more = mt.montage(ctx, project, {"count": 2})
    finally:
        tr.set_transcriber_override(None)
    assert more["pool_source_id"] == pool["id"]
    assert [db.get("clips", c)["title"] for c in more["clip_ids"]] == ["Montage 4", "Montage 5"]
    assert db.get("projects", project)["options"]["count"] == 2


def test_montage_needs_videos(db, settings, project):
    ctx = JobContext(settings, db, db.enqueue("montage", {"project_id": project}, project_id=project))
    with pytest.raises(PermanentError):
        mt.montage(ctx, project, {})
