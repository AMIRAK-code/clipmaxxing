"""Opt-in end-to-end proof with the REAL pipeline: faster-whisper, MediaPipe path,
Remotion via node, ffmpeg loudnorm. No fakes.

    KLIPZ_E2E=1 WHISPER_MODEL=tiny python -m pytest -q -s -m e2e tests/test_e2e_autoclip.py

Optional: KLIPZ_E2E_KEEP=<dir> copies the rendered mp4/cover files there.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from klipz_worker import ffmpeg
from klipz_worker.config import REPO_ROOT, Settings
from klipz_worker.db import Database, connect
from klipz_worker.handlers import build_handlers
from klipz_worker.runner import Runner
from klipz_worker.steps.render import measure_loudness

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(os.environ.get("KLIPZ_E2E") != "1", reason="set KLIPZ_E2E=1 to run"),
]


def _sample() -> Path:
    data = Path(os.environ.get("KLIPZ_DATA_DIR", "").strip() or Path.home() / ".klipz")
    p = data / "samples" / "sample.mp4"
    if not p.exists():
        subprocess.run([sys.executable, str(REPO_ROOT / "scripts" / "make-sample.py")], check=True)
    return p


def test_autoclip_end_to_end(tmp_path: Path):
    sample = _sample()
    settings = Settings(data_dir=tmp_path, worker_id="e2e", poll_interval=0.01,
                        whisper_model=os.environ.get("WHISPER_MODEL", "tiny"))
    db = Database(connect(settings.db_path, settings.migrations_dir))
    project = db.insert("projects", {"title": "E2E"})
    sid = db.insert("source_videos", {"project_id": project, "origin": "upload", "filename": "sample.mp4"})
    key = f"sources/{sid}/source.mp4"
    shutil.copy(sample, settings.storage_path(key))
    db.update("source_videos", sid, {"storage_key": key})
    job = db.enqueue("autoclip", {"source_video_id": sid, "max_clips": 2}, project_id=project)

    runner = Runner(settings, build_handlers(), db)
    t0 = time.time()
    timings: list[tuple[str, float]] = []
    while True:
        t1 = time.time()
        if not runner.run_once():
            break
        last = db.many("jobs", "select type, status from jobs order by updated_at desc limit 1")[0]
        timings.append((last["type"], round(time.time() - t1, 1)))
    total = time.time() - t0
    jobs = db.many("jobs", "select type, status, error, result from jobs order by created_at")
    print("\nJOB TIMINGS (s):", timings, "total", round(total, 1))
    assert all(j["status"] == "succeeded" for j in jobs), jobs
    assert [j["type"] for j in jobs].count("render") == 2

    transcript = db.one("transcripts", "select * from transcripts where source_video_id = ?", sid)
    text = " ".join(w["w"] for w in transcript["words"])
    print("TRANSCRIPT:", text)
    assert len(transcript["words"]) > 80

    clips = db.many("clips", "select * from clips where source_video_id = ?", sid)
    assert len(clips) == 2
    for c in clips:
        track = c["crop_track"]
        assert track and track["segments"], "crop track missing"
        assert track["segments"][0]["start"] == c["start_sec"] and track["segments"][-1]["end"] == c["end_sec"]
        print("CLIP", c["start_sec"], c["end_sec"], [(s["layout"], len(s["keys"])) for s in track["segments"]])

    renders = db.many("renders", "select * from renders")
    assert len(renders) == 2 and all(r["status"] == "ready" for r in renders), renders
    keep = os.environ.get("KLIPZ_E2E_KEEP")
    for r in renders:
        mp4 = settings.storage_path(r["storage_key"])
        info = ffmpeg.probe(mp4)
        assert (info["width"], info["height"]) == (1080, 1920)
        assert info["video_codec"] == "h264" and info["audio_codec"] == "aac"
        data = mp4.read_bytes()
        assert 0 <= data.find(b"moov") < data.find(b"mdat"), "not faststart"
        lufs = measure_loudness(mp4)["input_i"]
        print("RENDER", r["id"], f"{info['duration']:.1f}s", f"{r['size_bytes'] / 1e6:.1f} MB", f"LUFS {lufs:.2f}")
        assert abs(lufs - (-14.0)) <= 1.0
        assert settings.storage_path(r["cover_key"]).stat().st_size > 1000
        assert r["edit_version"] == 0 and r["lufs"] is not None
        if keep:
            Path(keep).mkdir(parents=True, exist_ok=True)
            shutil.copy(mp4, Path(keep) / f"{r['id']}.mp4")
            shutil.copy(settings.storage_path(r["cover_key"]), Path(keep) / f"{r['id']}.jpg")
    assert db.get("jobs", job["id"])["status"] == "succeeded"
