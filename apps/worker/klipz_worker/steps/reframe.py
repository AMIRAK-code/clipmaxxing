"""Reframe: clip -> clips.crop_track (9:16 follow-the-speaker crop plan).

Frames are decoded once at 5 fps through an ffmpeg pipe (rotation honoured),
faces are detected with an injected Detector, and the pure planner in
klipz_worker.reframe.planner turns detections + diarization + shot cuts into a
CropTrack."""
from __future__ import annotations

import logging
import subprocess
from typing import Any, Iterator, Optional

import numpy as np

from .. import ffmpeg
from ..reframe.detect import Detector, default_detector
from ..reframe.planner import PlanConfig, Sample, plan_track
from ..runner import JobContext, PermanentError
from .ingest import source_file

log = logging.getLogger("klipz.reframe")

SAMPLE_FPS = 5.0
DETECT_WIDTH = 640


def _even(x: float) -> int:
    return max(2, int(round(x / 2)) * 2)


def iter_frames(path: Any, start: float, end: float, src_w: int, src_h: int, fps: float = SAMPLE_FPS) -> Iterator[tuple[float, np.ndarray]]:
    """Yield (absolute_time, rgb_frame) at `fps`, downscaled to DETECT_WIDTH wide."""
    w = min(DETECT_WIDTH, _even(src_w))
    h = _even(w * src_h / src_w)
    cmd = [
        ffmpeg.binaries()[0], "-hide_banner", "-loglevel", "error", "-nostdin",
        "-ss", f"{start:.3f}", "-t", f"{max(0.1, end - start):.3f}", "-i", str(path),
        "-an", "-vf", f"fps={fps},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = w * h * 3
    i = 0
    try:
        assert proc.stdout is not None
        while True:
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            yield start + i / fps, np.frombuffer(buf, dtype=np.uint8).reshape(h, w, 3)
            i += 1
    finally:
        proc.kill()
        proc.wait()


FLAT_BLOCK = 8
FLAT_STD = 2.0  # 8x8 block with gray-level std below this counts as flat (no texture, no sensor noise)


def flat_fraction(gray: np.ndarray) -> float:
    """Fraction of 8x8 blocks that are perfectly flat. Slides, documents and UI have large flat areas;
    camera footage never does (sensor noise + texture + lighting gradients)."""
    h, w = (gray.shape[0] // FLAT_BLOCK) * FLAT_BLOCK, (gray.shape[1] // FLAT_BLOCK) * FLAT_BLOCK
    if h == 0 or w == 0:
        return 0.0
    blocks = gray[:h, :w].astype(np.float32).reshape(h // FLAT_BLOCK, FLAT_BLOCK, w // FLAT_BLOCK, FLAT_BLOCK)
    std = blocks.std(axis=(1, 3))
    return float(np.mean(std < FLAT_STD))


def frame_stats(prev_gray: Optional[np.ndarray], frame_rgb: np.ndarray) -> tuple[np.ndarray, float, float, float]:
    """(gray, motion, edge, flat): mean abs diff vs the previous frame, Canny edge fraction, flat-block fraction."""
    import cv2

    gray = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2GRAY)
    small = cv2.resize(gray, (160, max(2, int(160 * gray.shape[0] / gray.shape[1]))), interpolation=cv2.INTER_AREA)
    motion = 0.0 if prev_gray is None else float(np.mean(np.abs(small.astype(np.int16) - prev_gray.astype(np.int16)))) / 255.0
    edges = cv2.Canny(gray, 100, 200)
    return small, motion, float(np.count_nonzero(edges)) / edges.size, flat_fraction(gray)


def collect_samples(path: Any, start: float, end: float, src_w: int, src_h: int, detector: Detector,
                    on_progress: Optional[Any] = None) -> list[Sample]:
    samples: list[Sample] = []
    prev: Optional[np.ndarray] = None
    total = max(1, int((end - start) * SAMPLE_FPS))
    for t, frame in iter_frames(path, start, end, src_w, src_h):
        prev, motion, edge, flat = frame_stats(prev, frame)
        try:
            faces = detector.detect(frame)
        except Exception as e:  # noqa: BLE001 - one bad frame must not kill the clip
            log.warning("face detection failed at %.2fs: %s", t, e)
            faces = []
        samples.append(Sample(t=t, faces=faces, motion=motion, edge=edge, flat=flat))
        if on_progress and len(samples) % 10 == 0:
            on_progress(min(1.0, len(samples) / total))
    return samples


def words_in_range(transcript: Optional[dict[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    if not transcript:
        return []
    return [w for w in transcript.get("words") or [] if float(w["e"]) > start and float(w["s"]) < end]


def _refresh_smart_edit(ctx: JobContext, clip: dict[str, Any]) -> None:
    """A clip whose automatic edit was dropped because its range changed (trim) gets a fresh one.
    Only clips the person never edited (edit_version 0, no edit) are touched."""
    if not ctx.settings.smart_edit or clip.get("edit_state") is not None or int(clip.get("edit_version") or 0) != 0:
        return
    try:
        from . import smart_edit

        tr = ctx.db.one("transcripts", "select * from transcripts where source_video_id = ?", clip["source_video_id"])
        if not tr or not tr.get("words"):
            return
        edit = smart_edit.build_edit(
            tr["words"], float(clip["start_sec"]), float(clip["end_sec"]),
            keywords=(clip.get("score_breakdown") or {}).get("keywords") or [],
            hook=clip.get("hook"), style_id=clip.get("caption_style_id") or None,
        )
        ctx.db.update("clips", clip["id"], {"edit_state": edit})
        clip["edit_state"] = edit
    except Exception as e:  # noqa: BLE001
        log.warning("smart edit refresh failed for clip %s (%s)", clip.get("id"), e)


def reframe(ctx: JobContext, clip_id: str, force: bool = False, detector: Optional[Detector] = None,
            cfg: Optional[PlanConfig] = None) -> dict[str, Any]:
    """Compute and store clips.crop_track. Returns the track. Skips when one exists unless force."""
    db = ctx.db
    clip = db.get("clips", clip_id)
    if clip is None:
        raise PermanentError(f"clip {clip_id} was deleted; nothing to reframe")
    _refresh_smart_edit(ctx, clip)
    if clip.get("crop_track") and not force:
        ctx.progress(1.0, "Reframe already done", force=True)
        return clip["crop_track"]
    source = db.get("source_videos", clip["source_video_id"])
    if source is None:
        raise PermanentError("source video not found")
    path = source_file(ctx, source)
    if not (source.get("width") and source.get("height")):
        info = ffmpeg.probe(path)
        source["width"], source["height"] = info["width"], info["height"]
        db.update("source_videos", source["id"], {"width": info["width"], "height": info["height"]})
    src_w, src_h = int(source["width"]), int(source["height"])
    start, end = float(clip["start_sec"]), float(clip["end_sec"])

    ctx.progress(0.02, "Reframing: finding faces", force=True)
    det = detector or default_detector(ctx.settings.data_dir)
    try:
        samples = collect_samples(path, start, end, src_w, src_h, det, lambda p: ctx.progress(0.02 + 0.85 * p))
    finally:
        close = getattr(det, "close", None)
        if detector is None and callable(close):
            close()
    if db.get("clips", clip_id) is None:  # deleted while frames were being analysed
        raise PermanentError(f"clip {clip_id} was deleted while reframing")
    transcript = db.one("transcripts", "select * from transcripts where source_video_id = ?", source["id"])
    track, infos = plan_track(
        start=start, end=end, src_w=src_w, src_h=src_h, samples=samples,
        cuts=source.get("scene_cuts") or [], words=words_in_range(transcript, start, end), cfg=cfg,
    )
    ctx.progress(0.95, "Reframing: saving crop track", force=True)
    # Persist without bumping edit_version: the crop track is derived data.
    db.update("clips", clip_id, {"crop_track": track})
    log.info("reframed clip %s: %s", clip_id, [(i.layout, i.reason) for i in infos])
    ctx.progress(1.0, "Reframed", force=True)
    return track


def handle_reframe(ctx: JobContext) -> dict[str, Any]:
    clip_id = ctx.payload.get("clip_id")
    if not clip_id:
        raise PermanentError("payload.clip_id is required")
    track = reframe(ctx, clip_id, bool(ctx.payload.get("force")))
    return {"clip_id": clip_id, "segments": len(track["segments"]), "layouts": [s["layout"] for s in track["segments"]]}


HANDLERS = {"reframe": handle_reframe}
