"""Manual AI Mode: files for Gemini, and clips from the JSON it answers with."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from klipz_worker import ffmpeg
from klipz_worker.reframe.detect import NoFaceDetector
from klipz_worker.runner import JobContext, PermanentError
from klipz_worker.steps import manual_ai as ma
from klipz_worker.steps import transcribe as tr

from .conftest import add_source
from .test_montage import vertical_video  # noqa: F401  (fixture)


def W(text: str, s: float, e: float) -> dict[str, Any]:
    return {"w": text, "s": s, "e": e}


WORDS = [W("Here", 1.0, 1.3), W("is", 1.35, 1.5), W("the", 1.55, 1.7), W("secret.", 1.75, 2.3),
         W("Nobody", 4.0, 4.4), W("knows", 4.45, 4.8), W("it!", 4.85, 5.2), W("Wow.", 8.0, 8.5)]


class FakeTranscriber:
    name = "fake"

    def transcribe(self, audio_path: Path, duration: float, on_progress: Any) -> dict[str, Any]:
        return {"language": "en", "words": [dict(w) for w in WORDS], "model": "fake:1"}


@pytest.fixture()
def fakes(monkeypatch):
    from klipz_worker.steps import reframe as rf

    tr.set_transcriber_override(FakeTranscriber())
    monkeypatch.setattr(rf, "default_detector", lambda data_dir: NoFaceDetector())
    yield
    tr.set_transcriber_override(None)


def test_transcript_lists_sentences_with_seconds_per_video():
    text = ma.transcript_text([("talk.mp4", 12.0, WORDS), ("silent.mp4", 3.0, [])])
    lines = text.splitlines()
    assert lines[0] == "=== Video 1: talk.mp4 (length 12.0 s, 00:12.0) ==="
    assert "[1.00 - 2.30] Here is the secret." in lines
    assert "[4.00 - 5.20] Nobody knows it!" in lines
    assert "=== Video 2: silent.mp4 (length 3.0 s, 00:03.0) ===" in lines and "(no speech found)" in lines


def test_prompt_names_the_files_and_the_json_shape():
    one = ma.prompt_text([("talk.mp4", 120.0)], ["video_light.mp4"])
    assert '"text_on_screen"' in one and '"segments"' in one and '"video"' not in one and "video_light.mp4" in one
    two = ma.prompt_text([("a.mp4", 60.0), ("b.mp4", 90.0)], ["video_light_1.mp4", "video_light_2.mp4"])
    assert '"video": 1' in two and "video_light_2.mp4" in two


def test_segments_never_cut_a_word_and_touching_ones_join():
    out = ma.snap_segments([{"start": 1.4, "end": 2.0}, {"start": 4.1, "end": 4.6}, {"start": 7.0, "end": 7.1}], WORDS, 10.0)
    (s1, e1), (s2, e2) = out  # the 0.1 s one is dropped
    assert s1 < 1.35 and e1 > 2.3 and s2 < 4.0 and e2 > 4.8
    assert all(not (w["s"] < x < w["e"]) for w in WORDS for x in (s1, e1, s2, e2))
    assert ma.snap_segments([{"start": 0.5, "end": 3.0}, {"start": 3.0, "end": 6.0}], WORDS, 10.0) == [(0.5, 6.0)]
    assert ma.snap_segments([{"start": 9.0, "end": 30.0}], WORDS, 10.0) == [(9.0, 10.0)]


def test_export_writes_transcript_proxy_and_prompt(db, settings, project, sample_video, fakes):
    add_source(db, settings, project, sample_video)
    ctx = JobContext(settings, db, db.enqueue("manual_export", {"project_id": project}, project_id=project))
    out = ma.manual_export(ctx, project)
    folder = Path(out["folder"])
    assert out["files"] == ["video_transcript.txt", "video_light.mp4", "gemini_prompt.txt"]
    assert "[1.00 - 2.30] Here is the secret." in (folder / "video_transcript.txt").read_text(encoding="utf-8")
    proxy = folder / "video_light.mp4"
    info = ffmpeg.probe(proxy)
    assert info["height"] == 360 and info["width"] == 640 and info["has_audio"] and info["audio_codec"] == "aac"
    assert info["fps"] == pytest.approx(1.0, abs=0.01)
    assert proxy.stat().st_size < sample_video.stat().st_size / 3
    probe = subprocess.run([ffmpeg.binaries()[1], "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=bit_rate",
                            "-of", "json", str(proxy)], capture_output=True, text=True)
    assert int(json.loads(probe.stdout)["streams"][0]["bit_rate"]) <= 80_000
    assert out["keys"][1] == f"projects/{project}/manual/video_light.mp4"


def test_clips_from_the_plan_cut_the_original_video(db, settings, project, sample_video, fakes):
    sid = add_source(db, settings, project, sample_video)
    plan = [
        {"title": "The secret", "hook": "Nobody tells you this", "segments": [
            {"source": sid, "start": 1.4, "end": 2.0}, {"source": sid, "start": 4.1, "end": 5.0}]},
        {"title": "", "hook": "", "segments": [{"source": sid, "start": 7.5, "end": 9.0}]},
    ]
    ctx = JobContext(settings, db, db.enqueue("manual_clips", {"project_id": project, "clips": plan}, project_id=project))
    out = ma.manual_clips(ctx, project, plan)
    assert len(out["clip_ids"]) == 2 and len(out["render_ids"]) == 2
    a, b = (db.get("clips", c) for c in out["clip_ids"])
    assert a["source_video_id"] == sid and a["title"] == "The secret" and a["hook"] == "Nobody tells you this"
    es = a["edit_state"]
    assert len(es["video"]) == 2 and es["video"][0]["srcStart"] <= 1.35 and es["video"][1]["srcEnd"] >= 5.2  # out of "is" and "it!"
    assert es["captions"]["enabled"] is True and es["hook"] == {"enabled": True, "text": "Nobody tells you this", "durationSec": pytest.approx(min(4.0, sum(p["srcEnd"] - p["srcStart"] for p in es["video"])))}
    assert a["crop_track"] is not None and es["auto"] is False
    assert b["title"] == "Clip 2" and b["edit_state"]["hook"]["enabled"] is False
    assert len(db.many("jobs", "select * from jobs where type = 'render'")) == 2


def test_montage_projects_mix_videos_through_a_pool(db, settings, project, sample_video, vertical_video, fakes):  # noqa: F811
    db.update("projects", project, {"kind": "montage"})
    a = add_source(db, settings, project, sample_video)
    b = add_source(db, settings, project, vertical_video)
    plan = [{"title": "Mix", "hook": "Two in one", "segments": [
        {"source": a, "start": 1.0, "end": 2.3}, {"source": b, "start": 4.0, "end": 5.2}, {"source": a, "start": 1.0, "end": 2.3}]}]
    ctx = JobContext(settings, db, db.enqueue("manual_clips", {"project_id": project, "clips": plan}, project_id=project))
    out = ma.manual_clips(ctx, project, plan)
    clip = db.get("clips", out["clip_ids"][0])
    pool = db.get("source_videos", clip["source_video_id"])
    assert pool["role"] == "pool" and pool["status"] == "ready" and len(pool["scenes"]) == 2  # the repeated segment is cut once
    pieces = clip["edit_state"]["video"]
    assert len(pieces) == 3 and pieces[0]["srcStart"] == pieces[2]["srcStart"]
    assert pieces[1].get("frame") == ma.mt.CENTRE_CROP  # the phone video fills the screen
    assert clip["edit_state"]["captions"]["enabled"] and clip["edit_state"]["hook"]["text"] == "Two in one"


def test_bad_plans_are_refused(db, settings, project, sample_video, fakes):
    add_source(db, settings, project, sample_video)
    ctx = JobContext(settings, db, db.enqueue("manual_clips", {"project_id": project}, project_id=project))
    with pytest.raises(PermanentError):
        ma.manual_clips(ctx, project, [])
    with pytest.raises(PermanentError):
        ma.manual_clips(ctx, project, [{"title": "x", "segments": [{"source": "not-mine", "start": 0, "end": 2}]}])
