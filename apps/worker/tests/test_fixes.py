"""Regression tests for the 'fixes' track: render error classification, render currency (style change),
scene-cut detection, analyze --retranscribe, deleted-row robustness, cleanup vs live jobs."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from klipz_worker import ffmpeg
from klipz_worker.db import Database, now_iso
from klipz_worker.handlers import build_handlers
from klipz_worker.runner import JobContext, PermanentError, Runner
from klipz_worker.steps import autoclip as ac
from klipz_worker.steps import cleanup as cl
from klipz_worker.steps import render as rd
from klipz_worker.steps import transcribe as tr
from klipz_worker.steps.analyze import handle_analyze
from tests.conftest import add_source
from tests.test_analyze import FakeTranscriber, long_words, make_ctx, prepared_source
from tests.test_render_autoclip_cleanup import _clip, _stub_remotion, ctx_for, make_render_mp4


# ── 3a. render error classification ───────────────────────────────────────────
@pytest.mark.parametrize("msg", [
    "props.sourceUrl is required",
    "props need `edit` or `clip`",
    "usage: render.mjs --props <props.json> --out <out.mp4> [--storage <dir>]",
    "sourceUrl is not absolute and no --storage dir was given",
    "edit.video is empty: nothing to render (give at least one video piece or a `clip` range)",
    "Error: props.sourceUrl is required",
])
def test_bad_input_errors_are_permanent(msg):
    assert rd.is_bad_input(msg)


@pytest.mark.parametrize("msg", [
    "No frame found at position 12",
    "Compositor error: exited with code 1",
    "Could not serialize inputProps: out of memory",
    "Error: Cannot read properties of undefined (reading 'props')",
    "Chrome crashed while rendering props of frame 40",
    "Timed out after 30000ms delayRender() was called but not cleared",
    "ENOSPC: no space left on device, write",
    "Failed to fetch http://127.0.0.1:5555/src/video.mp4",
])
def test_transient_or_unknown_errors_stay_retryable(msg):
    assert not rd.is_bad_input(msg)


def test_run_remotion_error_classes(db, settings, project, tmp_path, monkeypatch):
    import sys

    script = tmp_path / "fake.py"
    script.write_text(
        "import sys, json, pathlib\n"
        "mode = pathlib.Path(sys.argv[sys.argv.index('--props') + 1]).read_text().strip()\n"
        "print(json.dumps({'type': 'error', 'message': mode}), flush=True)\n"
        "sys.exit(1)\n"
    )
    ctx = ctx_for(db, settings, project)
    for mode, exc in (("Could not serialize inputProps", rd.RenderError), ("props.sourceUrl is required", PermanentError)):
        props = tmp_path / "p.txt"
        props.write_text(mode)
        with pytest.raises(exc):
            rd.run_remotion(ctx, props, tmp_path / "o.mp4", tmp_path / "c.jpg", argv_prefix=[sys.executable, str(script)])


# ── 3b. autoclip must not reuse a render made with another caption style ──────
def _autoclip_env(db, settings, project, sample_video, monkeypatch):
    sid = add_source(db, settings, project, sample_video)
    db.update("source_videos", sid, {"width": 1280, "height": 720, "duration_sec": 12.0})
    cid = db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": 0.0, "end_sec": 2.5,
                              "score": 1.0, "caption_style_id": "bold-outline"})
    monkeypatch.setattr(ac, "analyze", lambda ctx, s, m, **k: {"clip_ids": [cid]})

    def fake_reframe(ctx, clip_id, **k):
        db.update("clips", clip_id, {"crop_track": {"version": 1, "srcW": 1, "srcH": 1, "segments": []}})
        return {}

    monkeypatch.setattr(ac, "reframe", fake_reframe)
    return sid, cid


def test_render_stores_fingerprint_and_it_tracks_style_edit_and_options(db, settings, project, sample_video, monkeypatch):
    _sid, cid = _clip(db, settings, project, sample_video)
    rid = db.insert("renders", {"clip_id": cid, "options": {"denoise": True}})
    _stub_remotion(monkeypatch, [])
    rd.render_clip(ctx_for(db, settings, project), rid)
    row = db.get("renders", rid)
    clip = db.get("clips", cid)
    assert row["options"]["denoise"] is True and row["options"]["fingerprint"] == rd.render_fingerprint(clip, row["options"])
    base = rd.render_fingerprint(clip, row["options"])
    assert rd.render_fingerprint({**clip, "caption_style_id": "comic-pop"}, row["options"]) != base
    assert rd.render_fingerprint({**clip, "edit_state": {"version": 1, "video": []}}, row["options"]) != base
    assert rd.render_fingerprint(clip, {**row["options"], "denoise": False}) != base
    assert rd.render_fingerprint(clip, row["options"]) == base  # deterministic


def test_autoclip_style_change_does_not_reuse_ready_render(db, settings, project, sample_video, monkeypatch):
    sid, cid = _autoclip_env(db, settings, project, sample_video, monkeypatch)
    ctx = ctx_for(db, settings, project, "autoclip", {"source_video_id": sid})
    out1 = ac.autoclip(ctx, sid, 1)  # first pass queues a render
    rid1 = out1["render_ids"][0]
    # simulate it finishing through the real render path: fingerprint recorded, status ready
    _stub_remotion(monkeypatch, [])
    rd.render_clip(ctx_for(db, settings, project), rid1)
    assert db.get("renders", rid1)["status"] == "ready"
    db.conn.execute("update jobs set status = 'succeeded' where type = 'render'")
    # same style again: reused, nothing new
    out2 = ac.autoclip(ctx, sid, 1, "bold-outline")
    assert out2["render_ids"] == [rid1] and db.conn.execute("select count(*) from renders").fetchone()[0] == 1
    # a different style: the ready render does NOT match the clip config any more -> new render + job
    out3 = ac.autoclip(ctx, sid, 1, "comic-pop")
    rid3 = out3["render_ids"][0]
    assert rid3 != rid1 and db.get("clips", cid)["caption_style_id"] == "comic-pop"
    assert db.get("renders", rid3)["status"] == "queued"
    assert db.conn.execute("select count(*) from jobs where type = 'render' and status = 'queued'").fetchone()[0] == 1
    # ... and that one becomes current again once rendered
    rd.render_clip(ctx_for(db, settings, project), rid3)
    db.conn.execute("update jobs set status = 'succeeded' where type = 'render'")
    assert ac.autoclip(ctx, sid, 1, "comic-pop")["render_ids"] == [rid3]


def test_autoclip_legacy_render_without_fingerprint(db, settings, project, sample_video, monkeypatch):
    sid, cid = _autoclip_env(db, settings, project, sample_video, monkeypatch)
    legacy = db.insert("renders", {"clip_id": cid, "status": "ready", "edit_version": 0, "options": {}})
    ctx = ctx_for(db, settings, project, "autoclip", {"source_video_id": sid})
    assert ac.autoclip(ctx, sid, 1)["render_ids"] == [legacy]  # edit version matches, style untouched
    out = ac.autoclip(ctx, sid, 1, "karaoke-neon")  # style changed in this call -> cannot prove it matches
    assert out["render_ids"] != [legacy]


def test_autoclip_in_flight_render_of_old_config_is_not_reused(db, settings, project, sample_video, monkeypatch):
    sid, cid = _autoclip_env(db, settings, project, sample_video, monkeypatch)
    clip = db.get("clips", cid)
    busy = db.insert("renders", {"clip_id": cid, "status": "rendering",
                                 "options": {"fingerprint": rd.render_fingerprint({**clip, "crop_track": {"x": 1}}, {})}})
    ctx = ctx_for(db, settings, project, "autoclip", {"source_video_id": sid})
    out = ac.autoclip(ctx, sid, 1)
    assert out["render_ids"][0] != busy


# ── 6. scene cuts ─────────────────────────────────────────────────────────────
def _multishot(path: Path, per: float = 2.5) -> list[float]:
    """5 hard cuts' worth of mixed content incl. the two weak pairs seen in scripts/make-sample.py
    (gradient -> dark solid; dark solid -> test pattern)."""
    size = "size=640x360:rate=30"
    srcs = [f"testsrc2={size}:duration={per}", f"smptebars={size}:duration={per}", f"gradients={size}:duration={per}:speed=0.05",
            f"color=c=0x1d3557:{size}:duration={per}", f"rgbtestsrc={size}:duration={per}"]
    args: list[str] = []
    for s in srcs:
        args += ["-f", "lavfi", "-i", s]
    chain = "".join(f"[{i}:v]setsar=1,format=yuv420p[v{i}];" for i in range(len(srcs)))
    chain += "".join(f"[v{i}]" for i in range(len(srcs))) + f"concat=n={len(srcs)}:v=1:a=0,fps=30[v]"
    ffmpeg.run_ffmpeg([*args, "-filter_complex", chain, "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)])
    return [round(per * i, 3) for i in range(1, len(srcs))]


def test_scene_cuts_find_every_hard_cut_including_weak_ones(tmp_path):
    expected = _multishot(tmp_path / "shots.mp4")
    got = ffmpeg.scene_cuts(tmp_path / "shots.mp4")
    assert len(got) == len(expected) == 4, got
    assert all(abs(g - e) <= 0.2 for g, e in zip(got, expected)), (got, expected)


@pytest.mark.parametrize("src", ["mandelbrot=size=640x360:rate=30:start_scale=3:end_scale=0.02", "gradients=size=640x360:rate=30:speed=0.5",
                                 "testsrc2=size=640x360:rate=30", "life=size=640x360:rate=30:mold=10:ratio=0.1"])
def test_scene_cuts_no_false_positives_on_continuous_lavfi_sources(tmp_path, src):
    out = tmp_path / "c.mp4"
    ffmpeg.run_ffmpeg(["-f", "lavfi", "-t", "6", "-i", src, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(out)])
    assert ffmpeg.scene_cuts(out) == []


def test_pick_cuts_rule():
    flat = [(round(i / 10, 1), 0.0) for i in range(100)]
    with_spike = [(t, 0.06 if t == 5.0 else s) for t, s in flat]
    assert ffmpeg.pick_cuts(with_spike) == [5.0]  # isolated weak jump = cut
    plateau = [(t, 0.08 if 3.0 <= t <= 6.0 else s) for t, s in flat]
    assert ffmpeg.pick_cuts(plateau) == []  # sustained motion / dissolve: no cut
    camera = [(t, 0.07 + 0.01 * (i % 3)) for i, (t, _s) in enumerate(flat)]
    assert ffmpeg.pick_cuts(camera) == []  # handheld footage with constant 0.07-0.09 scores
    assert ffmpeg.pick_cuts([(t, 0.4 if t == 2.0 else s) for t, s in flat]) == [2.0]  # strong cut always counts
    assert ffmpeg.pick_cuts([(t, 0.4 if t in (2.0, 2.3) else s) for t, s in flat]) == [2.0]  # near-duplicates merge
    assert ffmpeg.pick_cuts([(0.1, 0.9), (0.2, 0.0)]) == []  # the very first frames are ignored


def test_pick_cuts_is_fast_on_hours_of_handheld_footage():
    import time

    noisy = [(i / 10, 0.06 + 0.02 * (i % 4)) for i in range(36000)]  # 1 h at 10 fps, every frame above SCENE_MIN
    t0 = time.perf_counter()
    assert ffmpeg.pick_cuts(noisy) == []
    assert time.perf_counter() - t0 < 2.0


# ── 6b. analyze force + retranscribe ──────────────────────────────────────────
def test_analyze_force_retranscribe(settings, db, project, sample_video):
    settings.llm_provider, settings.anthropic_api_key, settings.ollama_model = "none", "", ""
    sid = prepared_source(settings, db, project, sample_video, 500.0)
    fake = FakeTranscriber(long_words(8))
    tr.set_transcriber_override(fake)
    try:
        handle_analyze(make_ctx(settings, db, project, {"source_video_id": sid, "max_clips": 3}))
        assert fake.calls == 1
        handle_analyze(make_ctx(settings, db, project, {"source_video_id": sid, "force": True}))
        assert fake.calls == 1  # transcript reused
        handle_analyze(make_ctx(settings, db, project, {"source_video_id": sid, "force": True, "retranscribe": True}))
        assert fake.calls == 2  # re-transcribed
        # without force the analysis is skipped entirely, so nothing is re-transcribed
        res = handle_analyze(make_ctx(settings, db, project, {"source_video_id": sid, "retranscribe": True}))
        assert res.get("skipped") and fake.calls == 2
        assert len(db.many("transcripts", "select * from transcripts where source_video_id = ?", sid)) == 1
    finally:
        tr.set_transcriber_override(None)


# ── 7. deleted rows ───────────────────────────────────────────────────────────
def _run_one(db: Database, settings, job_id: str) -> dict[str, Any]:
    Runner(settings, build_handlers(), db).run_once()
    return db.get("jobs", job_id)  # type: ignore[return-value]


def test_render_job_for_deleted_render_or_clip_dies_once_with_clear_message(db, settings, project, sample_video):
    sid, cid = _clip(db, settings, project, sample_video)
    rid = db.insert("renders", {"clip_id": cid})
    db.conn.execute("delete from clips where id = ?", (cid,))  # cascades to the renders row (clip deleted in the UI)
    assert db.get("renders", rid) is None
    job = db.enqueue("render", {"render_id": rid}, project_id=project)
    after = _run_one(db, settings, job["id"])
    assert after["status"] == "dead" and after["attempts"] == 1  # no retries
    assert "no longer exists" in after["error"] and "deleted" in after["error"]


def test_render_job_with_clip_gone_but_row_left(db, settings, project, sample_video):
    """FK enforcement off / racing delete: the row survives but its clip is gone."""
    _sid, cid = _clip(db, settings, project, sample_video)
    rid = db.insert("renders", {"clip_id": cid})
    db.conn.execute("PRAGMA foreign_keys = OFF")
    db.conn.execute("delete from clips where id = ?", (cid,))
    db.conn.execute("PRAGMA foreign_keys = ON")
    job = db.enqueue("render", {"render_id": rid}, project_id=project)
    after = _run_one(db, settings, job["id"])
    assert after["status"] == "dead" and after["attempts"] == 1 and "was deleted" in after["error"]
    assert db.get("renders", rid)["status"] == "failed"


def test_render_row_deleted_while_rendering_discards_output(db, settings, project, sample_video, monkeypatch):
    _sid, cid = _clip(db, settings, project, sample_video)
    rid = db.insert("renders", {"clip_id": cid})

    def fake(ctx, props_path, out, cover, **kw):
        make_render_mp4(out)
        cover.write_bytes(b"\xff\xd8x")
        db.conn.execute("delete from renders where id = ?", (rid,))  # user deleted the clip meanwhile
        return {}

    monkeypatch.setattr(rd, "run_remotion", fake)
    with pytest.raises(PermanentError, match="deleted while rendering"):
        rd.render_clip(ctx_for(db, settings, project), rid)
    assert not settings.storage_path(f"renders/{rid}/clip.mp4").exists()
    assert not (settings.data_dir / "tmp" / f"render-{rid}").exists()


def test_reframe_job_for_deleted_clip_dies_once(db, settings, project):
    job = db.enqueue("reframe", {"clip_id": "does-not-exist"}, project_id=project)
    after = _run_one(db, settings, job["id"])
    assert after["status"] == "dead" and after["attempts"] == 1 and "was deleted" in after["error"]


def test_autoclip_skips_clip_deleted_midway(db, settings, project, sample_video, monkeypatch):
    sid = add_source(db, settings, project, sample_video)
    keep = db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": 0, "end_sec": 2, "score": 1})
    gone = db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": 3, "end_sec": 5, "score": 0.5})
    monkeypatch.setattr(ac, "analyze", lambda ctx, s, m, **k: {"clip_ids": [keep, gone]})

    def fake_reframe(ctx, clip_id, **k):
        if clip_id == gone:
            db.conn.execute("delete from clips where id = ?", (gone,))
        else:
            db.update("clips", clip_id, {"crop_track": {"version": 1, "srcW": 1, "srcH": 1, "segments": []}})
        return {}

    monkeypatch.setattr(ac, "reframe", fake_reframe)
    out = ac.autoclip(ctx_for(db, settings, project, "autoclip", {"source_video_id": sid}), sid, 5)
    assert len(out["render_ids"]) == 1


# ── 7b. cleanup vs live jobs ──────────────────────────────────────────────────
def test_cleanup_never_touches_sources_with_live_jobs(db, settings, project):
    old = now_iso(-86400 * 2)

    def source(name: str) -> str:
        sid = db.insert("source_videos", {"project_id": project, "origin": "upload", "status": "ready", "expires_at": old,
                                          "storage_key": f"sources/{name}/source.mp4", "audio_key": f"sources/{name}/audio.wav"})
        for key in (f"sources/{name}/source.mp4", f"sources/{name}/audio.wav"):
            settings.storage_path(key).write_bytes(b"x" * 50)
        return sid

    direct, via_clip, via_render, running, failed_only, idle = (source(n) for n in ("a", "b", "c", "d", "e", "f"))
    clip_b = db.insert("clips", {"project_id": project, "source_video_id": via_clip, "start_sec": 0, "end_sec": 5})
    clip_c = db.insert("clips", {"project_id": project, "source_video_id": via_render, "start_sec": 0, "end_sec": 5})
    render_c = db.insert("renders", {"clip_id": clip_c})
    db.enqueue("transcribe", {"source_video_id": direct}, project_id=project)
    db.enqueue("reframe", {"clip_id": clip_b}, project_id=project)
    db.enqueue("render", {"render_id": render_c}, project_id=project)
    j = db.enqueue("analyze", {"source_video_id": running}, project_id=project)
    db.conn.execute("update jobs set status = 'running' where id = ?", (j["id"],))
    j2 = db.enqueue("analyze", {"source_video_id": failed_only}, project_id=project)
    db.conn.execute("update jobs set status = 'dead' where id = ?", (j2["id"],))

    res = cl.cleanup(ctx_for(db, settings, project, "cleanup"))
    for sid in (direct, via_clip, via_render, running):
        row = db.get("source_videos", sid)
        assert row["status"] == "ready" and row["storage_key"], sid
    for sid in (failed_only, idle):
        assert db.get("source_videos", sid)["status"] == "deleted"
    assert settings.storage_path("sources/a/source.mp4").exists() and settings.storage_path("sources/d/audio.wav").exists()
    assert not settings.storage_path("sources/f/source.mp4").exists()
    assert res["sources_deleted"] == 2 and res["sources_kept_busy"] == 4
    # once the jobs are done the next run removes them
    db.conn.execute("update jobs set status = 'succeeded'")
    assert cl.cleanup(ctx_for(db, settings, project, "cleanup"))["sources_deleted"] == 4


# ── loudness: peaky, wide-range audio must still land on -14 LUFS without breaking the true-peak ceiling ──
def test_finalize_hits_target_for_peaky_wide_range_audio(tmp_path):
    expr = "0.08*sin(2*PI*180*t)*(0.04+0.96*lt(mod(t,6),1.5))*(0.2+0.8*lt(mod(t,3),1.0))+0.9*lt(mod(t,2.5),0.003)*sin(2*PI*3000*t)"
    src, dst = tmp_path / "raw.mp4", tmp_path / "out.mp4"
    ffmpeg.run_ffmpeg(["-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=18", "-f", "lavfi", "-i", f"aevalsrc='{expr}':s=48000:d=18",
                       "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(src)])
    lufs = rd.finalize(src, dst)
    assert lufs is not None and abs(lufs + 14.0) <= 0.5  # loudnorm alone gave -14.7 here
    m = rd.measure_loudness(dst)
    assert m["input_tp"] <= -0.5
    assert not list(tmp_path.glob("*.trim.mp4"))
