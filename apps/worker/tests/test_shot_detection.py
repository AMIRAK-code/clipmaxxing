"""Shot detection at import reads keyframes only; exact cuts are found per clip when they are needed."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from klipz_worker import ffmpeg
from klipz_worker.db import Database
from klipz_worker.runner import JobContext
from klipz_worker.steps import ingest as ing

from .conftest import add_source


def multishot(path: Path, per: float = 2.5, gop: int | None = None) -> list[float]:
    """Five different pictures, a hard cut every `per` seconds. `gop` = frames between keyframes."""
    size = "size=640x360:rate=30"
    srcs = [f"testsrc2={size}:duration={per}", f"smptebars={size}:duration={per}", f"gradients={size}:duration={per}:speed=0.05",
            f"color=c=0x1d3557:{size}:duration={per}", f"rgbtestsrc={size}:duration={per}"]
    args: list[str] = []
    for s in srcs:
        args += ["-f", "lavfi", "-i", s]
    chain = "".join(f"[{i}:v]setsar=1,format=yuv420p[v{i}];" for i in range(len(srcs)))
    chain += "".join(f"[v{i}]" for i in range(len(srcs))) + f"concat=n={len(srcs)}:v=1:a=0,fps=30[v]"
    keyint = ["-g", str(gop), "-keyint_min", str(gop)] if gop else []
    ffmpeg.run_ffmpeg([*args, "-filter_complex", chain, "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", *keyint,
                       "-pix_fmt", "yuv420p", str(path)])
    return [round(per * i, 3) for i in range(1, len(srcs))]


def test_pick_coarse_cuts_rule():
    pick = ffmpeg.pick_coarse_cuts
    # a talking head: every keyframe differs a little from the last one, steadily -> no cuts
    steady = [(float(i), 0.04) for i in range(20)]
    assert pick(steady) == []
    # a new picture in the middle of it stands out
    assert pick([*steady[:10], (10.0, 0.11), *steady[11:]]) == [10.0]
    # constant heavy motion (game footage) reads as changing pictures: that is what the pacing score wants
    assert len(pick([(float(i), 0.3) for i in range(10)])) == 9
    # the very first keyframe has nothing before it, and flashes closer than half a second merge
    assert pick([(0.0, 0.9), (1.0, 0.01), (2.0, 0.5), (2.3, 0.5), (4.0, 0.01)]) == [2.0]


def test_quick_scan_uses_keyframes_when_there_are_enough(tmp_path: Path):
    video = tmp_path / "short-gop.mp4"
    expected = multishot(video, gop=15)  # a keyframe every half second, like phone footage
    seen: list[float] = []
    cuts, mode = ffmpeg.quick_scene_cuts(video, 12.5, seen.append)
    assert mode == "coarse"
    assert seen and seen[-1] == 1.0 and seen == sorted(seen)
    for e in expected:  # found, to the keyframe
        assert any(abs(c - e) <= 0.5 for c in cuts), (e, cuts)


def test_quick_scan_falls_back_to_every_frame_when_keyframes_are_rare(tmp_path: Path):
    video = tmp_path / "long-gop.mp4"
    expected = multishot(video)  # ultrafast x264: one keyframe every 250 frames
    cuts, mode = ffmpeg.quick_scene_cuts(video, 12.5)
    assert mode == "full"
    assert len(cuts) == len(expected) and all(abs(c - e) <= 0.2 for c, e in zip(cuts, expected)), cuts


def test_full_scan_reports_progress_while_it_runs(tmp_path: Path):
    video = tmp_path / "v.mp4"
    multishot(video)
    seen: list[float] = []
    ffmpeg.scene_cuts(video, on_progress=seen.append, duration=12.5)
    assert len(seen) > 20 and 0 < seen[3] < 0.5 and seen[-1] == 1.0


def test_exact_cuts_inside_a_window(tmp_path: Path):
    video = tmp_path / "v.mp4"
    multishot(video, gop=15)
    got = ffmpeg.scene_cuts_between(video, 4.0, 8.0)  # cuts are at 2.5, 5, 7.5, 10
    assert len(got) == 2 and abs(got[0] - 5.0) <= 0.2 and abs(got[1] - 7.5) <= 0.2, got
    assert ffmpeg.scene_cuts_between(video, 5.5, 7.0) == []


def ctx_for(db: Database, settings, project: str) -> JobContext:
    return JobContext(settings, db, db.enqueue("reframe", {}, project_id=project))


def test_clip_cuts_refines_coarse_cuts_once_and_remembers(settings, db: Database, project, tmp_path: Path, monkeypatch):
    video = tmp_path / "v.mp4"
    multishot(video, gop=15)
    sid = add_source(db, settings, project, video)
    db.update("source_videos", sid, {"scene_cuts": [2.0, 5.5, 7.0, 10.0]})  # keyframe times, a little off
    settings.storage_path(f"sources/{sid}/cuts.json").write_text(json.dumps({"mode": "coarse", "windows": []}))
    ctx = ctx_for(db, settings, project)
    source = db.get("source_videos", sid)

    got = ing.clip_cuts(ctx, source, 4.0, 8.0)
    assert len(got) == 2 and abs(got[0] - 5.0) <= 0.2 and abs(got[1] - 7.5) <= 0.2, got
    # the same stretch (or a part of it) again: answered from the file, no decoding
    monkeypatch.setattr(ffmpeg, "scene_cuts_between", lambda *a, **k: pytest.fail("should come from cuts.json"))
    assert ing.clip_cuts(ctx, source, 4.0, 8.0) == got
    assert ing.clip_cuts(ctx, source, 4.5, 6.0) == got[:1]


def test_clip_cuts_keeps_exact_cuts_and_survives_a_failed_scan(settings, db: Database, project, sample_video, monkeypatch):
    sid = add_source(db, settings, project, sample_video)
    db.update("source_videos", sid, {"scene_cuts": [1.0, 6.0, 11.0]})
    ctx = ctx_for(db, settings, project)
    source = db.get("source_videos", sid)
    # no cuts.json: a source imported before 0.2.1, its cuts are already exact
    monkeypatch.setattr(ffmpeg, "scene_cuts_between", lambda *a, **k: pytest.fail("not needed"))
    assert ing.clip_cuts(ctx, source, 5.0, 12.0) == [6.0, 11.0]

    def broken(*a, **k):
        raise ffmpeg.FfmpegError("boom")

    settings.storage_path(f"sources/{sid}/cuts.json").write_text(json.dumps({"mode": "coarse", "windows": []}))
    monkeypatch.setattr(ffmpeg, "scene_cuts_between", broken)
    assert ing.clip_cuts(ctx, source, 5.0, 12.0) == [6.0, 11.0]  # falls back to what import found
