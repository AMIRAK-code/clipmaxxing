from __future__ import annotations

import math
import random
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np
import pytest

from klipz_worker.config import Settings
from klipz_worker.db import Database
from klipz_worker.reframe import detect as det
from klipz_worker.reframe.detect import Face, NoFaceDetector
from klipz_worker.reframe.oneeuro import OneEuroFilter, dead_zone, smooth_series
from klipz_worker.reframe.planner import (
    PlanConfig, Sample, assign_speakers, clamp_center, link_tracks, plan_track, simplify_keys,
    speech_turns, stable_speakers, window_norm,
)
from klipz_worker.runner import JobContext
from klipz_worker.steps import reframe as rf
from tests.conftest import add_source

DT = 0.2


def times(a: float, b: float) -> list[float]:
    n = int(round((b - a) / DT))
    return [round(a + i * DT, 6) for i in range(n)]


def face(cx: float, cy: float = 0.4, w: float = 0.1, mouth: Optional[float] = 0.02) -> Face:
    return Face(cx=cx, cy=cy, w=w, h=w * 1.3, mouth=mouth)


def samples_from(ts: list[float], fn: Callable[[float], list[Face]], motion: float = 0.2, edge: float = 0.01) -> list[Sample]:
    return [Sample(t=t, faces=fn(t), motion=motion, edge=edge) for t in ts]


def words_for(turns: list[tuple[str, float, float]]) -> list[dict[str, Any]]:
    out = []
    for spk, s, e in turns:
        t = s
        while t + 0.3 <= e + 1e-9:
            out.append({"w": "x", "s": round(t, 3), "e": round(t + 0.3, 3), "spk": spk})
            t += 0.35
    return out


# ── one-euro filter ────────────────────────────────────────────────────────
def test_one_euro_attenuates_jitter():
    rng = random.Random(1)
    ts = [i * DT for i in range(150)]
    noisy = [0.5 + rng.uniform(-0.005, 0.005) for _ in ts]
    out = smooth_series(ts, noisy)
    assert np.std(out[10:]) < 0.6 * np.std(noisy[10:])


def test_one_euro_tracks_fast_moves_with_low_lag():
    ts = [i * DT for i in range(40)]
    fast = [0.1 + 0.5 * t for t in ts]  # 0.5 units/s pan
    out = smooth_series(ts, fast)
    lag_s = (fast[-1] - out[-1]) / 0.5
    assert lag_s < 0.3
    fixed = OneEuroFilter(min_cutoff=0.4, beta=0.0)  # same resting cutoff, no speed adaptation
    fixed_out = [fixed(v, t) for t, v in zip(ts, fast)]
    assert out[-1] > fixed_out[-1]
    step = smooth_series(ts, [0.2 if t < 4 else 0.8 for t in ts])
    assert step[ts.index(4.0) + 1] > 0.5  # a jump is followed within one sample


def test_dead_zone_ignores_tiny_motion_but_follows_big():
    out = dead_zone([0.5, 0.505, 0.495, 0.51, 0.6, 0.7], 0.02)
    assert out[:4] == [0.5, 0.5, 0.5, 0.5]
    assert out[-1] == pytest.approx(0.68)  # follows, staying one dead-zone behind


# ── geometry ───────────────────────────────────────────────────────────────
def test_window_clamping_at_frame_edges():
    ww, wh = window_norm(1280, 720, 9 / 16)
    assert ww == pytest.approx(0.3164, abs=1e-3) and wh == 1.0
    assert clamp_center(0.02, 0.1, ww, wh) == (pytest.approx(ww / 2), 0.5)
    assert clamp_center(0.99, 0.9, ww, wh)[0] == pytest.approx(1 - ww / 2)
    assert clamp_center(0.5, 0.5, ww, wh) == (0.5, 0.5)


def test_planned_keys_stay_inside_frame():
    ts = times(0, 6)
    sm = samples_from(ts, lambda t: [face(0.02 if t < 3 else 0.985)])
    track, _ = plan_track(start=0, end=6, src_w=1280, src_h=720, samples=sm, cuts=[], words=[])
    ww = window_norm(1280, 720, 9 / 16)[0]
    for k in track["segments"][0]["keys"]:
        assert ww / 2 - 1e-4 <= k["cx"] <= 1 - ww / 2 + 1e-4


# ── track linking ──────────────────────────────────────────────────────────
def test_link_tracks_two_faces_and_gap():
    ts = times(0, 4)
    per = []
    for t in ts:
        fs = [face(0.25), face(0.75)]
        if 1.0 <= t < 1.6:  # right face missed for 3 samples
            fs = [face(0.25)]
        per.append(fs)
    tracks = link_tracks(per, ts, max_gap=1.0)
    assert len(tracks) == 2
    assert sorted(len(t.obs) for t in tracks) == [17, 20]
    right = next(t for t in tracks if len(t.obs) == 17)
    assert right.at(6) == pytest.approx((0.75, 0.4))  # interpolated across the gap


def test_link_tracks_splits_after_long_gap_and_never_swaps():
    ts = times(0, 6)
    per = [[face(0.3)] if (t < 1.0 or t >= 3.0) else [] for t in ts]
    assert len(link_tracks(per, ts, max_gap=1.0)) == 2
    # crossing faces keep their identity
    per2 = [[face(0.4 + 0.01 * i), face(0.6 - 0.01 * i)] for i in range(10)]
    tr = link_tracks(per2, times(0, 2), 1.0)
    assert len(tr) == 2 and all(len(t.obs) == 10 for t in tr)


# ── speakers ───────────────────────────────────────────────────────────────
def two_person_scene(turns, left_talks_when, ts):
    """left face (0.25) moves its mouth only when spk A talks, right (0.75) when B talks."""
    rng = random.Random(7)

    def fn(t: float) -> list[Face]:
        who = next((s for s, a, b in turns if a <= t < b), None)
        ml = 0.01 + (rng.uniform(0, 0.06) if who == "A" else 0.0)
        mr = 0.01 + (rng.uniform(0, 0.06) if who == "B" else 0.0)
        return [face(0.25, mouth=ml), face(0.75, mouth=mr)]

    return samples_from(ts, fn)


def test_speaker_to_track_assignment_alternating():
    turns = [("A", 0, 3), ("B", 3, 6), ("A", 6, 9), ("B", 9, 12)]
    ts = times(0, 12)
    sm = two_person_scene(turns, None, ts)
    tracks = link_tracks([s.faces for s in sm], ts)
    raw = [next((s for s, a, b in turns if a <= t < b), None) for t in ts]
    mapping = assign_speakers(tracks, raw, len(ts))
    xa = tracks[mapping["A"]].obs[0].cx
    xb = tracks[mapping["B"]].obs[0].cx
    assert xa == 0.25 and xb == 0.75


def test_active_speaker_drives_crop_single_shot_with_listener():
    """Not split (only A talks); crop must sit on A even though B is the larger face."""
    ts = times(0, 8)
    rng = random.Random(3)
    sm = samples_from(ts, lambda t: [face(0.25, w=0.08, mouth=0.01 + rng.uniform(0, 0.06)), face(0.75, w=0.12, mouth=0.02)])
    track, infos = plan_track(start=0, end=8, src_w=1280, src_h=720, samples=sm, cuts=[],
                              words=words_for([("A", 0, 8)]))
    assert infos[0].layout == "crop" and infos[0].reason == "speaker-follow"
    assert all(k["cx"] < 0.5 for k in track["segments"][0]["keys"])


def test_speaker_hysteresis_ignores_short_interjections():
    ts = times(0, 10)
    base = [("A", 0, 10)]
    raw_short = [("B" if 4.0 <= t < 4.6 else "A") for t in ts]
    assert set(stable_speakers(raw_short, ts, 1.0)) == {"A"}
    raw_long = [("B" if t >= 4.0 else "A") for t in ts]
    out = stable_speakers(raw_long, ts, 1.0)
    assert out[0] == "A" and out[-1] == "B"
    assert out[ts.index(4.0)] == "B"  # applied from where B started, no late pan
    # ping-pong every 0.6 s never switches
    pp = [("A" if int(t / 0.6) % 2 == 0 else "B") for t in ts]
    assert len(set(stable_speakers(pp, ts, 1.0))) == 1
    assert base


def test_subject_switches_after_one_second_of_other_speaker():
    ts = times(0, 12)
    turns = [("A", 0, 4), ("B", 4, 12)]
    rng = random.Random(5)

    def fn(t: float) -> list[Face]:
        a = turns[0][1] <= t < turns[0][2]
        return [face(0.25, w=0.08, mouth=0.01 + (rng.uniform(0, 0.06) if a else 0)),
                face(0.75, w=0.08, mouth=0.01 + (0 if a else rng.uniform(0, 0.06)))]

    cfg = PlanConfig(split_presence=2.0)  # disable split for this test
    track, _ = plan_track(start=0, end=12, src_w=1280, src_h=720, samples=samples_from(ts, fn), cuts=[],
                          words=words_for(turns), cfg=cfg)
    keys = track["segments"][0]["keys"]
    assert keys[0]["cx"] < 0.45 and keys[-1]["cx"] > 0.55
    assert len(keys) <= 2 * 12 + 1


# ── shots / hard cuts ───────────────────────────────────────────────────────
def test_hard_cut_segments_tile_exactly_and_keys_never_cross():
    ts = times(10, 40)
    # shot 1 (10-22): face left; shot 2 (22-31): face right; shot 3 (31-40): no face, busy
    def fn(t: float) -> list[Face]:
        if t < 22:
            return [face(0.3)]
        if t < 31:
            return [face(0.7)]
        return []

    sm = samples_from(ts, fn)
    track, infos = plan_track(start=10, end=40, src_w=1280, src_h=720, samples=sm, cuts=[22.0, 31.0, 5.0, 40.0, 10.1],
                              words=[])
    segs = track["segments"]
    assert [(s["start"], s["end"]) for s in segs] == [(10, 22.0), (22.0, 31.0), (31.0, 40)]
    for a, b in zip(segs, segs[1:]):
        assert a["end"] == b["start"]
    for s in segs:
        for k in s["keys"] + s.get("keys2", []):
            assert s["start"] - 1e-9 <= k["t"] <= s["end"] + 1e-9
    assert segs[0]["keys"][0]["cx"] < 0.4 and segs[1]["keys"][0]["cx"] > 0.6
    assert [i.layout for i in infos] == ["crop", "crop", "crop"]


# ── fallbacks ───────────────────────────────────────────────────────────────
def test_no_faces_centre_crop():
    ts = times(0, 5)
    sm = samples_from(ts, lambda t: [], motion=0.3, edge=0.01)
    track, infos = plan_track(start=0, end=5, src_w=1280, src_h=720, samples=sm, cuts=[], words=[])
    s = track["segments"][0]
    assert s["layout"] == "crop" and s["keys"] == [{"t": 0, "cx": 0.5, "cy": 0.5}] and infos[0].reason == "no-faces"


@pytest.mark.parametrize("motion,edge", [(0.005, 0.01), (0.3, 0.12)])
def test_screen_content_letterbox(motion, edge):
    sm = samples_from(times(0, 5), lambda t: [], motion=motion, edge=edge)
    track, infos = plan_track(start=0, end=5, src_w=1920, src_h=1080, samples=sm, cuts=[], words=[])
    assert track["segments"][0]["layout"] == "letterbox" and infos[0].reason == "screen-content"


def test_portrait_source_never_letterboxed_and_tiny_source_is():
    sm = samples_from(times(0, 5), lambda t: [], motion=0.0, edge=0.2)
    track, _ = plan_track(start=0, end=5, src_w=1080, src_h=1920, samples=sm, cuts=[], words=[])
    assert track["segments"][0]["layout"] == "crop"
    track, infos = plan_track(start=0, end=5, src_w=480, src_h=270, samples=sm, cuts=[], words=[])
    assert track["segments"][0]["layout"] == "letterbox" and infos[0].reason == "tiny-source"


def test_two_visible_talking_people_split_left_on_top():
    ts = times(0, 12)
    turns = [("A", 0, 4), ("B", 4, 8), ("A", 8, 12)]
    # speaker labels deliberately assigned to the RIGHT person first: top must still be the left person
    rng = random.Random(9)

    def fn(t: float) -> list[Face]:
        who = next(s for s, a, b in turns if a <= t < b)
        return [face(0.72, mouth=0.01 + (rng.uniform(0, 0.06) if who == "A" else 0)),
                face(0.28, mouth=0.01 + (rng.uniform(0, 0.06) if who == "B" else 0))]

    track, infos = plan_track(start=0, end=12, src_w=1280, src_h=720, samples=samples_from(ts, fn), cuts=[],
                              words=words_for(turns))
    s = track["segments"][0]
    assert s["layout"] == "split" and infos[0].reason == "two-speakers"
    assert s["keys"][0]["cx"] < 0.5 < s["keys2"][0]["cx"]
    sw = window_norm(1280, 720, 1080 / 960)[0]
    for k in s["keys"] + s["keys2"]:
        assert sw / 2 - 1e-4 <= k["cx"] <= 1 - sw / 2 + 1e-4


def test_two_faces_but_one_speaker_is_not_split():
    ts = times(0, 8)
    sm = samples_from(ts, lambda t: [face(0.28), face(0.72)])
    track, infos = plan_track(start=0, end=8, src_w=1280, src_h=720, samples=sm, cuts=[], words=words_for([("A", 0, 8)]))
    assert infos[0].layout == "crop"


# ── keyframes ───────────────────────────────────────────────────────────────
def test_keyframe_decimation_bounds_and_collinear_drop():
    # a straight pan is collinear: 2 keys; static = 1 key
    pts = [(i * 0.2, 0.3 + 0.01 * i, 0.5) for i in range(51)]
    assert len(simplify_keys(pts, 0.005, 21)) == 2
    assert len(simplify_keys([(i * 0.2, 0.5, 0.5) for i in range(51)], 0.005, 21)) == 1
    # a busy path is capped to <= ~2 keys per second
    rng = random.Random(2)
    ts = times(0, 20)
    sm = samples_from(ts, lambda t: [face(0.2 + 0.6 * (0.5 + 0.5 * math.sin(t * 1.3)) + rng.uniform(-0.01, 0.01))])
    track, _ = plan_track(start=0, end=20, src_w=1280, src_h=720, samples=sm, cuts=[], words=[])
    keys = track["segments"][0]["keys"]
    assert 2 < len(keys) <= 2 * 20 + 1
    assert keys[0]["t"] == 0 and keys[-1]["t"] == 20
    assert all(b["t"] > a["t"] for a, b in zip(keys, keys[1:]))


def test_jitter_does_not_move_the_crop():
    rng = random.Random(4)
    ts = times(0, 8)
    sm = samples_from(ts, lambda t: [face(0.5 + rng.uniform(-0.01, 0.01))])
    track, _ = plan_track(start=0, end=8, src_w=1280, src_h=720, samples=sm, cuts=[], words=[])
    assert len(track["segments"][0]["keys"]) == 1


# ── detector plumbing ───────────────────────────────────────────────────────
class _P:  # fake landmark
    def __init__(self, x: float, y: float):
        self.x, self.y = x, y


def test_faces_from_landmarks_box_and_mouth():
    lms = [_P(0.4 + 0.2 * (i % 2), 0.3 + 0.2 * (i % 3) / 2) for i in range(478)]
    lms[13], lms[14] = _P(0.5, 0.45), _P(0.5, 0.47)
    f = det.faces_from_landmarks([lms])[0]
    assert f.cx == pytest.approx(0.5) and f.cy == pytest.approx(0.4) and f.mouth == pytest.approx(0.02 / 0.2)
    assert det.faces_from_landmarks(None) == []


def test_model_download_soft_fails_offline_and_caches(tmp_path: Path):
    import httpx

    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    det._download_failed_at = 0.0
    assert det.ensure_model(tmp_path, transport=httpx.MockTransport(boom), allow_download=True) is None
    assert det.ensure_model(tmp_path, allow_download=False) is None
    det._download_failed_at = 0.0
    payload = b"x" * 200_000
    ok = httpx.MockTransport(lambda r: httpx.Response(200, content=payload))
    p = det.ensure_model(tmp_path, transport=ok, allow_download=True)
    assert p is not None and p.read_bytes() == payload
    assert det.ensure_model(tmp_path, allow_download=False) == p  # cached
    assert not list(tmp_path.rglob("*.part"))


# ── step integration ────────────────────────────────────────────────────────
class ScriptedDetector:
    """Detects a 'face' wherever the frame has a bright square (see test)."""

    def __init__(self) -> None:
        self.calls = 0

    def detect(self, frame_rgb: np.ndarray) -> list[Face]:
        self.calls += 1
        return [face(0.3)]


def _make_clip(db: Database, settings: Settings, project: str, video: Path, start=1.0, end=11.0) -> tuple[str, str]:
    sid = add_source(db, settings, project, video)
    db.update("source_videos", sid, {"width": 1280, "height": 720, "duration_sec": 12.0, "scene_cuts": [6.0]})
    db.insert("transcripts", {"source_video_id": sid, "words": [{"w": "hi", "s": 1.0, "e": 1.3, "spk": "S1"}]})
    cid = db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": start, "end_sec": end})
    return sid, cid


def _ctx(db: Database, settings: Settings, project: str) -> JobContext:
    job = db.enqueue("reframe", {}, project_id=project)
    return JobContext(settings, db, job)


def test_reframe_step_idempotent_and_hard_cut(db, settings, project, sample_video):
    _sid, cid = _make_clip(db, settings, project, sample_video)
    ctx = _ctx(db, settings, project)
    d = ScriptedDetector()
    track = rf.reframe(ctx, cid, detector=d)
    segs = track["segments"]
    assert [(s["start"], s["end"]) for s in segs] == [(1.0, 6.0), (6.0, 11.0)]
    assert d.calls >= 45
    assert db.get("clips", cid)["crop_track"] == track
    d2 = ScriptedDetector()
    again = rf.reframe(ctx, cid, detector=d2)
    assert again == track and d2.calls == 0  # skipped: crop_track exists
    rf.reframe(ctx, cid, force=True, detector=d2)
    assert d2.calls > 0
    assert db.get("clips", cid)["edit_version"] == 0  # derived data does not bump the edit version


def test_handle_reframe_and_registration(db, settings, project, sample_video, monkeypatch):
    from klipz_worker.handlers import build_handlers

    assert "reframe" in build_handlers()
    _sid, cid = _make_clip(db, settings, project, sample_video)
    monkeypatch.setattr(rf, "default_detector", lambda _d: NoFaceDetector())
    job = db.enqueue("reframe", {"clip_id": cid}, project_id=project)
    out = rf.handle_reframe(JobContext(settings, db, job))
    assert out["clip_id"] == cid and out["segments"] == 2
    assert db.get("clips", cid)["crop_track"]["segments"][0]["layout"] in ("crop", "letterbox")


def test_real_mediapipe_path_on_sample_video_falls_back_without_model(db, settings, project, sample_video):
    """Runs the real default_detector (MediaPipe Tasks) + real ffmpeg decode on the sample video.
    No face model is cached in a clean temp dir and downloads are disabled, so the
    detector must soft-fail to centre/letterbox fallbacks."""
    _sid, cid = _make_clip(db, settings, project, sample_video)
    ctx = _ctx(db, settings, project)
    import os

    os.environ["KLIPZ_MODEL_DOWNLOAD"] = "0"
    try:
        track = rf.reframe(ctx, cid)  # default detector
    finally:
        os.environ.pop("KLIPZ_MODEL_DOWNLOAD", None)
    assert track["segments"][0]["layout"] in ("crop", "letterbox")
    assert track["srcW"] == 1280 and len(track["segments"]) == 2


def test_real_mediapipe_detection_on_bundled_face_image():
    """Real face detection on matplotlib's bundled grace_hopper.jpg; needs the cached model."""
    import cv2
    import matplotlib

    from klipz_worker.config import data_dir

    model = det.model_path(data_dir())
    if not model.exists():
        pytest.skip("face_landmarker.task not cached (offline / download disabled)")
    img = cv2.imread(str(Path(matplotlib.get_data_path()) / "sample_data" / "grace_hopper.jpg"))
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    faces = det.MediaPipeDetector(model).detect(rgb)
    assert len(faces) == 1 and 0.2 < faces[0].cx < 0.8 and faces[0].mouth is not None


def test_speech_turns_merge():
    w = words_for([("A", 0, 2), ("B", 2.2, 4)])
    assert [(s, round(a, 2)) for s, a, _ in speech_turns(w)] == [("A", 0.0), ("B", 2.2)]
