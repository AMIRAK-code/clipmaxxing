from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from klipz_worker import ffmpeg
from klipz_worker.db import Database, now_iso
from klipz_worker.handlers import build_handlers
from klipz_worker.runner import JobCancelled, JobContext, PermanentError, Runner
from klipz_worker.steps import autoclip as ac
from klipz_worker.steps import cleanup as cl
from klipz_worker.steps import render as rd
from klipz_worker.steps import voiceover as vo
from tests.conftest import add_source


def ctx_for(db: Database, settings, project: str, type_: str = "render", payload: dict | None = None) -> JobContext:
    job = db.enqueue(type_, payload or {}, project_id=project)
    return JobContext(settings, db, job)


def make_render_mp4(path: Path, *, volume: float = 0.03, audio: bool = True) -> None:
    args = ["-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=3"]
    if audio:
        args += ["-f", "lavfi", "-i", "sine=frequency=300:duration=3"]
    args += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if audio:
        args += ["-af", f"volume={volume}", "-c:a", "aac", "-shortest"]
    ffmpeg.run_ffmpeg([*args, str(path)])


def moov_before_mdat(path: Path) -> bool:
    data = path.read_bytes()
    return 0 <= data.find(b"moov") < data.find(b"mdat")


# ── registration ────────────────────────────────────────────────────────────
def test_all_handlers_registered():
    h = build_handlers()
    for t in ("reframe", "render", "autoclip", "voiceover", "cleanup", "analyze", "ingest", "transcribe"):
        assert t in h


# ── post-process ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("vol", [0.03, 0.9])
def test_finalize_loudnorm_copy_video_faststart(tmp_path: Path, vol: float):
    src, dst = tmp_path / "raw.mp4", tmp_path / "out.mp4"
    make_render_mp4(src, volume=vol)
    lufs = rd.finalize(src, dst)
    assert lufs is not None and abs(lufs - (-14.0)) <= 1.0
    info = rd.verify_output(dst)
    assert info["audio_codec"] == "aac" and info["video_codec"] == "h264"
    assert moov_before_mdat(dst)
    # video was stream-copied: identical packet payload size
    def vbytes(p: Path) -> int:
        out = subprocess.run([ffmpeg.binaries()[1], "-v", "error", "-select_streams", "v", "-show_entries",
                              "packet=size", "-of", "csv=p=0", str(p)], capture_output=True, text=True).stdout
        return sum(int(x) for x in out.split())
    assert vbytes(src) == vbytes(dst)
    out = subprocess.run([ffmpeg.binaries()[1], "-v", "error", "-select_streams", "a", "-show_entries",
                          "stream=sample_rate", "-of", "csv=p=0", str(dst)], capture_output=True, text=True).stdout
    assert out.strip() == "48000"


def test_finalize_denoise_and_silent_audio(tmp_path: Path):
    src = tmp_path / "raw.mp4"
    make_render_mp4(src)
    assert abs(rd.finalize(src, tmp_path / "d.mp4", denoise=True) + 14) <= 1.0  # type: ignore[operator]
    silent = tmp_path / "silent.mp4"
    make_render_mp4(silent, volume=0.0)
    assert rd.finalize(silent, tmp_path / "s.mp4") is None
    noaudio = tmp_path / "na.mp4"
    make_render_mp4(noaudio, audio=False)
    assert rd.finalize(noaudio, tmp_path / "na_out.mp4") is None
    assert ffmpeg.probe(tmp_path / "na_out.mp4")["audio_codec"] == "aac"


def test_verify_output_rejects_wrong_size(tmp_path: Path):
    p = tmp_path / "x.mp4"
    ffmpeg.run_ffmpeg(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=1", "-f", "lavfi", "-i",
                       "sine=duration=1", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(p)])
    with pytest.raises(rd.RenderError, match="640x360"):
        rd.verify_output(p)


# ── node runner (fake node script speaking the same JSON protocol) ──────────────
FAKE_NODE = textwrap.dedent('''
    import json, sys, time, pathlib
    a = sys.argv[1:]
    get = lambda k: a[a.index(k) + 1]
    mode = pathlib.Path(get("--props")).read_text().strip()
    def emit(o): print(json.dumps(o), flush=True)
    if mode == "ok":
        emit({"type": "progress", "progress": 0.0, "stage": "bundling"})
        emit({"type": "progress", "progress": 0.5, "stage": "rendering"})
        pathlib.Path(get("--out")).write_bytes(b"video"); pathlib.Path(get("--cover")).write_bytes(b"jpg")
        emit({"type": "done", "out": get("--out"), "frames": 90})
    elif mode == "error":
        emit({"type": "error", "message": "No frame found at position 12"}); sys.exit(1)
    elif mode == "bad":
        emit({"type": "error", "message": "props.sourceUrl is required"}); sys.exit(1)
    elif mode == "hang":
        pathlib.Path(get("--out") + ".pid").write_text(str(__import__("os").getpid()))
        emit({"type": "progress", "progress": 0.1, "stage": "rendering"}); time.sleep(120)
''')


@pytest.fixture()
def fake_node(tmp_path: Path) -> list[str]:
    script = tmp_path / "fake_node.py"
    script.write_text(FAKE_NODE)
    return [sys.executable, str(script)]


def _run(ctx: JobContext, tmp_path: Path, mode: str, prefix: list[str]) -> dict[str, Any]:
    props = tmp_path / "props.txt"
    props.write_text(mode)
    return rd.run_remotion(ctx, props, tmp_path / "o.mp4", tmp_path / "c.jpg", argv_prefix=prefix)


def test_run_remotion_streams_progress_and_surfaces_errors(db, settings, project, tmp_path, fake_node):
    ctx = ctx_for(db, settings, project)
    done = _run(ctx, tmp_path, "ok", fake_node)
    assert done["frames"] == 90 and (tmp_path / "o.mp4").exists()
    assert db.get("jobs", ctx.job["id"])["progress"] >= 0.5
    with pytest.raises(rd.RenderError, match="No frame found"):
        _run(ctx, tmp_path, "error", fake_node)
    with pytest.raises(PermanentError, match="sourceUrl"):
        _run(ctx, tmp_path, "bad", fake_node)


def test_run_remotion_cancellation_kills_child(db, settings, project, tmp_path, fake_node):
    ctx = ctx_for(db, settings, project)
    db.conn.execute("update jobs set status = 'cancelled' where id = ?", (ctx.job["id"],))
    t0 = time.time()
    with pytest.raises(JobCancelled):
        _run(ctx, tmp_path, "hang", fake_node)
    assert time.time() - t0 < 20
    pid = int((tmp_path / "o.mp4.pid").read_text())
    time.sleep(0.5)
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}"], capture_output=True, text=True).stdout
        assert str(pid) not in out.replace("PID", "")
    else:
        with pytest.raises(OSError):
            os.kill(pid, 0)


def test_find_node_missing_is_permanent(monkeypatch):
    monkeypatch.setattr(rd.shutil, "which", lambda _n: None)
    with pytest.raises(PermanentError, match="Node.js"):
        rd.find_node()


# ── render_clip end to end with a stubbed node ─────────────────────────────────
def _clip(db, settings, project, video, **kw) -> tuple[str, str]:
    sid = add_source(db, settings, project, video)
    db.update("source_videos", sid, {"width": 1280, "height": 720, "duration_sec": 12.0, "scene_cuts": []})
    db.insert("transcripts", {"source_video_id": sid, "words": [
        {"w": "Hello", "s": 1.0, "e": 1.4, "spk": "S1"}, {"w": "world", "s": 1.5, "e": 1.9, "spk": "S1"},
        {"w": "later", "s": 9.0, "e": 9.3, "spk": "S1"}]})
    cid = db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": 1.0, "end_sec": 5.0,
                              "hook": "A hook", "caption_style_id": "bold-outline",
                              "score_breakdown": {"keywords": ["world"]},
                              "crop_track": {"version": 1, "srcW": 1280, "srcH": 720, "segments": [
                                  {"start": 1.0, "end": 5.0, "layout": "crop", "keys": [{"t": 1.0, "cx": .5, "cy": .5}]}]},
                              **kw})
    return sid, cid


def test_build_props_derives_clip_when_no_edit(db, settings, project, sample_video):
    _sid, cid = _clip(db, settings, project, sample_video)
    ctx = ctx_for(db, settings, project)
    clip = db.get("clips", cid)
    src = db.get("source_videos", clip["source_video_id"])
    p = rd.build_props(ctx, clip, src, {})
    assert p["sourceUrl"] == src["storage_key"] and p["srcW"] == 1280 and p["assetBaseUrl"] == ""
    assert p["clip"]["words"] == [w for w in p["clip"]["words"] if w["s"] < 5] and len(p["clip"]["words"]) == 2
    assert p["clip"]["keywords"] == ["world"] and p["clip"]["hook"] == "A hook" and p["clip"]["styleId"] == "bold-outline"
    assert p["edit"] is None and p["cropTrack"]["segments"]
    # with an edit_state: it is passed through, voiceover appended
    edit = {"version": 1, "video": [], "audio": []}
    db.update("clips", cid, {"edit_state": edit})
    vo_file = settings.storage_path("assets/vo.mp3")
    ffmpeg.run_ffmpeg(["-f", "lavfi", "-i", "sine=duration=2", str(vo_file)])
    p2 = rd.build_props(ctx, db.get("clips", cid), src, {"voiceover_key": "assets/vo.mp3"})
    assert "clip" not in p2 and p2["edit"]["audio"][0]["src"] == "assets/vo.mp3"
    assert p2["edit"]["audio"][0]["duration"] == pytest.approx(2.0, abs=0.2)


def _stub_remotion(monkeypatch, calls: list):
    def fake(ctx, props_path, out, cover, **kw):
        calls.append(json.loads(Path(props_path).read_text()))
        make_render_mp4(out, volume=0.05)
        cover.write_bytes(b"\xff\xd8jpeg")
        ctx.progress(0.5, "Rendering video")
        return {"type": "done"}

    monkeypatch.setattr(rd, "run_remotion", fake)


def test_render_clip_ready_row_atomic_and_noop(db, settings, project, sample_video, monkeypatch):
    _sid, cid = _clip(db, settings, project, sample_video, edit_version=3)
    rid = db.insert("renders", {"clip_id": cid, "options": {"denoise": True}})
    calls: list = []
    _stub_remotion(monkeypatch, calls)
    out = rd.render_clip(ctx_for(db, settings, project, payload={"render_id": rid}), rid)
    r = db.get("renders", rid)
    assert r["status"] == "ready" and r["storage_key"] == f"renders/{rid}/clip.mp4" and r["cover_key"].endswith("cover.jpg")
    assert (r["width"], r["height"], r["fps"]) == (1080, 1920, 30.0)
    assert r["video_codec"] == "h264" and r["audio_codec"] == "aac" and abs(r["lufs"] + 14) <= 1.0
    assert r["edit_version"] == 3 and r["completed_at"] and r["size_bytes"] == settings.storage_path(r["storage_key"]).stat().st_size
    assert moov_before_mdat(settings.storage_path(r["storage_key"]))
    assert settings.storage_path(r["cover_key"]).exists()
    assert not list(settings.storage_dir.rglob("*.part*")) and not (settings.data_dir / "tmp" / f"render-{rid}").exists()
    assert out["render_id"] == rid and len(calls) == 1
    again = rd.render_clip(ctx_for(db, settings, project), rid)
    assert again["skipped"] and len(calls) == 1  # no-op


def test_render_clip_runs_reframe_when_track_missing(db, settings, project, sample_video, monkeypatch):
    _sid, cid = _clip(db, settings, project, sample_video)
    db.update("clips", cid, {"crop_track": None})
    rid = db.insert("renders", {"clip_id": cid})
    calls: list = []
    _stub_remotion(monkeypatch, calls)
    seen: list[str] = []
    monkeypatch.setattr(rd, "reframe", lambda ctx, clip_id, **k: (seen.append(clip_id), db.update(
        "clips", clip_id, {"crop_track": {"version": 1, "srcW": 1280, "srcH": 720, "segments": []}}))[0])
    rd.render_clip(ctx_for(db, settings, project), rid)
    assert seen == [cid] and calls[0]["cropTrack"]["srcW"] == 1280


def test_render_failure_states(db, settings, project, sample_video, monkeypatch):
    _sid, cid = _clip(db, settings, project, sample_video)
    rid = db.insert("renders", {"clip_id": cid})

    def boom(*a, **k):
        raise rd.RenderError("compositor exploded")

    monkeypatch.setattr(rd, "run_remotion", boom)
    ctx = ctx_for(db, settings, project)
    with pytest.raises(rd.RenderError):
        rd.render_clip(ctx, rid)
    assert db.get("renders", rid)["status"] == "queued"  # attempts left: job will retry
    db.conn.execute("update jobs set attempts = max_attempts where id = ?", (ctx.job["id"],))
    ctx.job = db.get("jobs", ctx.job["id"])  # type: ignore[assignment]
    with pytest.raises(rd.RenderError):
        rd.render_clip(ctx, rid)
    r = db.get("renders", rid)
    assert r["status"] == "failed" and "compositor exploded" in r["error"]
    with pytest.raises(PermanentError):
        rd.render_clip(ctx, "nope")


def test_render_early_failures_do_not_leave_row_stuck(db, settings, project, sample_video):
    # media missing before node even starts: PermanentError, and the row must not stay queued/rendering
    sid, cid = _clip(db, settings, project, sample_video)
    settings.storage_path(db.get("source_videos", sid)["storage_key"]).unlink()
    rid = db.insert("renders", {"clip_id": cid})
    with pytest.raises(PermanentError):
        rd.render_clip(ctx_for(db, settings, project), rid)
    r = db.get("renders", rid)
    assert r["status"] == "failed" and "missing" in r["error"]
    # no dimensions: failure after status flipped to 'rendering'
    sid2, cid2 = _clip(db, settings, project, sample_video)
    db.update("source_videos", sid2, {"width": None})
    rid2 = db.insert("renders", {"clip_id": cid2})
    with pytest.raises(PermanentError):
        rd.render_clip(ctx_for(db, settings, project), rid2)
    assert db.get("renders", rid2)["status"] == "failed"


def test_transient_error_is_retried_once(db, settings, project, sample_video, monkeypatch):
    _sid, cid = _clip(db, settings, project, sample_video)
    rid = db.insert("renders", {"clip_id": cid})
    n = {"i": 0}

    def flaky(ctx, props_path, out, cover, **kw):
        n["i"] += 1
        if n["i"] == 1:
            raise rd.RenderError("No frame found at position 77")
        make_render_mp4(out)
        cover.write_bytes(b"x")
        return {}

    monkeypatch.setattr(rd, "run_remotion", flaky)
    rd.render_clip(ctx_for(db, settings, project), rid)
    assert n["i"] == 2 and db.get("renders", rid)["status"] == "ready"


# ── voiceover ──────────────────────────────────────────────────────────────────
def _mp3_bytes(tmp_path: Path) -> bytes:
    p = tmp_path / "t.mp3"
    ffmpeg.run_ffmpeg(["-f", "lavfi", "-i", "sine=frequency=200:duration=2", str(p)])
    return p.read_bytes()


def test_voiceover_requires_key(db, settings, project):
    settings.elevenlabs_api_key = ""
    ctx = ctx_for(db, settings, project, "voiceover", {"clip_id": "c", "text": "hi"})
    with pytest.raises(PermanentError, match="ELEVENLABS_API_KEY"):
        vo.handle_voiceover(ctx)


def test_voiceover_mocked_http(db, settings, project, tmp_path):
    settings.elevenlabs_api_key = "test-key"
    audio = _mp3_bytes(tmp_path)
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["key"], seen["body"] = str(request.url), request.headers.get("xi-api-key"), json.loads(request.content)
        return httpx.Response(200, content=audio)

    ctx = ctx_for(db, settings, project, "voiceover", {"clip_id": "c", "text": "Hello there"})
    out = vo.voiceover(ctx, "Hello there", "voice123", transport=httpx.MockTransport(handler))
    assert seen["url"].startswith("https://api.elevenlabs.io/v1/text-to-speech/voice123") and seen["key"] == "test-key"
    assert seen["body"]["text"] == "Hello there"
    assert out["storage_key"].startswith("assets/voiceover-") and out["storage_key"].endswith(".mp3")
    assert out["duration_sec"] == pytest.approx(2.0, abs=0.3)
    assert settings.storage_path(out["storage_key"]).read_bytes() == audio


def test_voiceover_http_errors(db, settings, project):
    settings.elevenlabs_api_key = "k"
    ctx = ctx_for(db, settings, project, "voiceover")
    with pytest.raises(PermanentError, match="401"):
        vo.voiceover(ctx, "x", transport=httpx.MockTransport(lambda r: httpx.Response(401, text="bad key")))
    with pytest.raises(RuntimeError, match="429"):
        vo.voiceover(ctx, "x", transport=httpx.MockTransport(lambda r: httpx.Response(429, text="slow down")))
    with pytest.raises(PermanentError):
        vo.voiceover(ctx, "  ")


# ── autoclip ───────────────────────────────────────────────────────────────────
def test_autoclip_creates_renders_and_is_idempotent(db, settings, project, sample_video, monkeypatch):
    sid = add_source(db, settings, project, sample_video)
    clip_ids = [db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": i * 3.0,
                                    "end_sec": i * 3.0 + 2.5, "score": 1 - i * 0.1}) for i in range(2)]
    calls = {"analyze": 0, "reframe": []}

    def fake_analyze(ctx, source_video_id, max_clips, **k):
        calls["analyze"] += 1
        return {"clip_ids": clip_ids, "clips_created": 2}

    def fake_reframe(ctx, clip_id, **k):
        calls["reframe"].append(clip_id)
        db.update("clips", clip_id, {"crop_track": {"version": 1, "srcW": 1, "srcH": 1, "segments": []}})
        return {}

    monkeypatch.setattr(ac, "analyze", fake_analyze)
    monkeypatch.setattr(ac, "reframe", fake_reframe)
    ctx = ctx_for(db, settings, project, "autoclip", {"source_video_id": sid})
    out = ac.autoclip(ctx, sid, 2, "karaoke")
    assert out["clip_ids"] == clip_ids and len(out["render_ids"]) == 2
    assert all(db.get("clips", c)["caption_style_id"] == "karaoke" for c in clip_ids)
    jobs = db.many("jobs", "select * from jobs where type = 'render' order by created_at")
    assert len(jobs) == 2
    assert {j["dedupe_key"] for j in jobs} == {f"render:{r}" for r in out["render_ids"]}
    assert all(j["parent_job_id"] == ctx.job["id"] and j["project_id"] == project for j in jobs)
    # retry: analyze reports "already analyzed" (no ids); nothing is duplicated
    monkeypatch.setattr(ac, "analyze", lambda *a, **k: {"clip_ids": [], "skipped": True})
    out2 = ac.autoclip(ctx, sid, 2)
    assert out2["render_ids"] == out["render_ids"]
    assert db.conn.execute("select count(*) from renders").fetchone()[0] == 2
    assert db.conn.execute("select count(*) from jobs where type = 'render'").fetchone()[0] == 2
    # a ready render for the current edit version is not re-queued; a stale one is
    rid = out["render_ids"][0]
    db.conn.execute("update jobs set status = 'succeeded' where type = 'render'")
    db.update("renders", rid, {"status": "ready", "edit_version": 0})
    ac.autoclip(ctx, sid, 2)
    assert db.conn.execute("select count(*) from renders").fetchone()[0] == 2
    db.update("clips", clip_ids[0], {"edit_version": 1})
    out3 = ac.autoclip(ctx, sid, 2)
    assert db.conn.execute("select count(*) from renders").fetchone()[0] == 3 and out3["render_ids"][0] != rid


def test_autoclip_bad_payload(db, settings, project):
    with pytest.raises(PermanentError):
        ac.handle_autoclip(ctx_for(db, settings, project, "autoclip", {}))
    with pytest.raises(PermanentError, match="not found"):
        ac.autoclip(ctx_for(db, settings, project, "autoclip"), "missing")


# ── cleanup ────────────────────────────────────────────────────────────────────
def test_cleanup_all_parts(db, settings, project):
    st = settings.storage_dir
    old = now_iso(-86400 * 2)
    expired = db.insert("source_videos", {"project_id": project, "origin": "upload", "status": "ready",
                                          "storage_key": "sources/a/source.mp4", "audio_key": "sources/a/audio.wav",
                                          "expires_at": old})
    fresh = db.insert("source_videos", {"project_id": project, "origin": "upload", "status": "ready",
                                        "storage_key": "sources/b/source.mp4", "expires_at": now_iso(86400)})
    for key in ("sources/a/source.mp4", "sources/a/audio.wav", "sources/a/thumb.jpg", "sources/b/source.mp4"):
        settings.storage_path(key).write_bytes(b"x" * 100)
    outside = st.parent / "outside.txt"
    outside.write_text("keep me")
    clip = db.insert("clips", {"project_id": project, "source_video_id": expired, "start_sec": 0, "end_sec": 5})
    rid = db.insert("renders", {"clip_id": clip, "status": "ready", "storage_key": "renders/r/clip.mp4"})
    settings.storage_path("renders/r/clip.mp4").write_bytes(b"mp4")
    # stale and fresh .part files
    stale_part, fresh_part = settings.storage_path("uploads/u1/file.mp4.part"), settings.storage_path("uploads/u2/file.mp4.part")
    stale_part.write_bytes(b"p"); fresh_part.write_bytes(b"p")
    old_t = time.time() - 25 * 3600
    os.utime(stale_part, (old_t, old_t))
    # jobs: old succeeded/cancelled go, old failed/dead + recent succeeded stay
    def job(status: str, days: float) -> str:
        j = db.enqueue("x", {}, project_id=project)
        db.conn.execute("update jobs set status = ?, finished_at = ?, updated_at = ? where id = ?",
                        (status, now_iso(-86400 * days), now_iso(-86400 * days), j["id"]))
        return j["id"]
    gone = [job("succeeded", 31), job("cancelled", 40)]
    kept = [job("succeeded", 5), job("dead", 60), job("queued", 90)]
    ctx = ctx_for(db, settings, project, "cleanup")
    res = cl.cleanup(ctx)
    assert res["sources_deleted"] == 1 and res["part_files_deleted"] == 1 and res["jobs_deleted"] == 2
    assert res["bytes_freed"] >= 200
    s = db.get("source_videos", expired)
    assert s["status"] == "deleted" and s["storage_key"] is None and s["audio_key"] is None
    assert not settings.storage_path("sources/a/source.mp4").exists() and not settings.storage_path("sources/a/audio.wav").exists()
    assert settings.storage_path("sources/a/thumb.jpg").exists()  # thumbnail kept
    assert db.get("source_videos", fresh)["status"] == "ready" and settings.storage_path("sources/b/source.mp4").exists()
    assert db.get("clips", clip) is not None and settings.storage_path("renders/r/clip.mp4").exists()
    assert db.get("renders", rid)["status"] == "ready"
    assert not stale_part.exists() and fresh_part.exists()
    assert all(db.get("jobs", j) is None for j in gone) and all(db.get("jobs", j) is not None for j in kept)
    assert outside.read_text() == "keep me"
    assert cl.cleanup(ctx)["sources_deleted"] == 0  # idempotent


def test_cleanup_never_deletes_outside_storage(settings, tmp_path):
    victim = settings.data_dir / "klipz.db"
    victim.write_bytes(b"precious")
    root = settings.storage_dir
    assert cl.safe_unlink(root, "../klipz.db") == 0 and victim.exists()
    assert cl.safe_unlink(root, str(victim)) == 0 and victim.exists()
    assert cl.safe_unlink(root, "") == 0 and cl.safe_unlink(root, None) == 0
    assert cl.safe_unlink(root, ".") == 0 and root.exists()


def test_runner_enqueues_one_cleanup_per_utc_day(db, settings):
    r = Runner(settings, build_handlers(), db)
    assert r.maybe_enqueue_cleanup() is True
    assert r.maybe_enqueue_cleanup() is False  # still queued
    r.run_once()  # runs the cleanup job to completion
    rows = db.many("jobs", "select * from jobs where type = 'cleanup'")
    assert len(rows) == 1 and rows[0]["status"] == "succeeded" and rows[0]["dedupe_key"].startswith("cleanup:")
    assert r.maybe_enqueue_cleanup() is False  # not again the same day, even though it finished
    assert db.conn.execute("select count(*) from jobs where type = 'cleanup'").fetchone()[0] == 1
