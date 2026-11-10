from __future__ import annotations

import pytest

from klipz_worker.db import Database, now_iso
from klipz_worker.runner import JobContext, PermanentError, Runner
from klipz_worker.steps.ingest import handle_ingest
from klipz_worker.steps.youtube import parse_video_id

from .conftest import add_source


def test_enqueue_is_idempotent_while_live(db: Database):
    a = db.enqueue("analyze", {"x": 1}, dedupe_key="analyze:1")
    b = db.enqueue("analyze", {"x": 2}, dedupe_key="analyze:1")
    assert a["id"] == b["id"]
    assert b["payload"] == {"x": 1}
    job = db.claim("w1", ["analyze"])
    assert job and job["id"] == a["id"] and job["attempts"] == 1
    assert db.claim("w2", ["analyze"]) is None  # claimed exactly once
    db.complete(a["id"], {"ok": True})
    c = db.enqueue("analyze", {"x": 3}, dedupe_key="analyze:1")
    assert c["id"] != a["id"]  # finished work frees the key


def test_claim_respects_type_and_run_after(db: Database):
    db.enqueue("render", {})
    assert db.claim("w", ["analyze"]) is None
    later = db.enqueue("analyze", {})
    db.update("jobs", later["id"], {"run_after": now_iso(3600)})
    assert db.claim("w", ["analyze"]) is None


def test_failure_backs_off_then_dead_letters(db: Database):
    job = db.enqueue("analyze", {}, max_attempts=2)
    db.claim("w", ["analyze"])
    assert db.fail(job["id"], "boom") == "queued"
    row = db.get("jobs", job["id"])
    assert row["status"] == "queued" and row["run_after"] > now_iso() and row["error"] == "boom"
    db.update("jobs", job["id"], {"run_after": now_iso(-1)})
    db.claim("w", ["analyze"])
    assert db.fail(job["id"], "boom again") == "dead"
    assert db.get("jobs", job["id"])["status"] == "dead"


def test_stale_running_job_is_reclaimed_then_dead(db: Database):
    job = db.enqueue("render", {}, max_attempts=2)
    db.claim("w1", ["render"])
    db.update("jobs", job["id"], {"heartbeat_at": now_iso(-600)})
    again = db.claim("w2", ["render"], stale_seconds=120)
    assert again and again["locked_by"] == "w2" and again["attempts"] == 2
    db.update("jobs", job["id"], {"heartbeat_at": now_iso(-600)})
    assert db.claim("w3", ["render"], stale_seconds=120) is None
    assert db.get("jobs", job["id"])["status"] == "dead"


def test_runner_reports_progress_retries_and_permanent_errors(settings, db: Database):
    seen: list[float] = []
    calls = {"n": 0}

    def flaky(ctx: JobContext):
        calls["n"] += 1
        ctx.sub(0.0, 0.5).progress(1.0, "half", force=True)
        seen.append(ctx.db.get("jobs", ctx.job["id"])["progress"])
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return {"done": True}

    def bad(ctx: JobContext):
        raise PermanentError("bad input")

    runner = Runner(settings, {"analyze": flaky, "render": bad}, db)
    j = db.enqueue("analyze", {})
    assert runner.run_once() is True
    assert db.get("jobs", j["id"])["status"] == "queued"
    db.update("jobs", j["id"], {"run_after": now_iso(-1)})
    assert runner.run_once() is True
    row = db.get("jobs", j["id"])
    assert row["status"] == "succeeded" and row["progress"] == 1 and row["result"] == {"done": True}
    assert seen == [0.5, 0.5]

    b = db.enqueue("render", {})
    runner.run_once()
    assert db.get("jobs", b["id"])["status"] == "dead"  # no retries for permanent errors
    assert runner.run_once() is False


def test_cancelled_job_stops_at_next_progress(settings, db: Database):
    def handler(ctx: JobContext):
        ctx.db.update("jobs", ctx.job["id"], {"status": "cancelled"})
        ctx.progress(0.5, "working")
        raise AssertionError("should not get here")

    runner = Runner(settings, {"analyze": handler}, db)
    j = db.enqueue("analyze", {})
    runner.run_once()
    assert db.get("jobs", j["id"])["status"] == "cancelled"


def test_ingest_probes_extracts_audio_and_is_rerunnable(settings, db: Database, project, sample_video):
    sid = add_source(db, settings, project, sample_video)
    runner = Runner(settings, {"ingest": handle_ingest}, db)
    job = db.enqueue("ingest", {"source_video_id": sid}, project_id=project)
    runner.run_once()
    assert db.get("jobs", job["id"])["status"] == "succeeded", db.get("jobs", job["id"])["error"]
    src = db.get("source_videos", sid)
    assert src["status"] == "ready"
    assert (src["width"], src["height"]) == (1280, 720)
    assert src["duration_sec"] == pytest.approx(12, abs=0.3)
    assert settings.storage_path(src["audio_key"]).stat().st_size > 300_000  # ~12 s of 16 kHz PCM
    assert any(abs(c - 6.0) < 0.4 for c in src["scene_cuts"]), src["scene_cuts"]
    rms = src["energy"]["rms"]
    assert sum(rms[14:22]) > sum(rms[2:10]) * 3  # louder second half

    # second run: everything is already there, so nothing is recomputed
    audio = settings.storage_path(src["audio_key"])
    mtime = audio.stat().st_mtime_ns
    db.enqueue("ingest", {"source_video_id": sid}, project_id=project)
    runner.run_once()
    assert audio.stat().st_mtime_ns == mtime


def test_ingest_missing_file_is_permanent(settings, db: Database, project):
    sid = db.insert("source_videos", {"project_id": project, "origin": "upload", "storage_key": "sources/nope/source.mp4"})
    runner = Runner(settings, {"ingest": handle_ingest}, db)
    job = db.enqueue("ingest", {"source_video_id": sid})
    runner.run_once()
    assert db.get("jobs", job["id"])["status"] == "dead"


@pytest.mark.parametrize(
    "url,ok",
    [
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", True),
        ("https://youtu.be/dQw4w9WgXcQ?t=10", True),
        ("https://www.youtube.com/shorts/dQw4w9WgXcQ", True),
        ("https://www.youtube.com/watch?feature=x&v=dQw4w9WgXcQ", True),
        ("https://example.com/watch?v=dQw4w9WgXcQ", False),
        ("file:///etc/passwd", False),
        ("https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ", False),
    ],
)
def test_youtube_url_validation(url, ok):
    assert (parse_video_id(url) is not None) is ok
