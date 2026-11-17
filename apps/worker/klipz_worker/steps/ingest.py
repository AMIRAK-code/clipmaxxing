"""Ingest: probe the source, extract 16 kHz mono audio, find shot changes and
the loudness curve. Each part is skipped when its output already exists, so
re-running after a crash only redoes what is missing."""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .. import ffmpeg
from ..runner import JobContext, PermanentError


log = logging.getLogger("klipz.ingest")


def source_file(ctx: JobContext, source: dict) -> Path:
    if not source.get("storage_key"):
        raise PermanentError("source video has no file yet")
    path = ctx.settings.storage_path(source["storage_key"])
    if not path.exists():
        raise PermanentError(f"source file missing: {source['storage_key']}")
    return path


# sources/<id>/cuts.json: how the stored shot changes were found, plus the stretches already looked at
# frame by frame. {"mode": "coarse" | "full", "windows": [{"s", "e", "cuts": [...]}]}. No file = a source
# from before 0.2.1, whose cuts are exact.
MAX_CUT_WINDOWS = 200


def _cuts_info_path(ctx: JobContext, source_video_id: str) -> Path:
    return ctx.settings.storage_path(f"sources/{source_video_id}/cuts.json")


def _read_cuts_info(ctx: JobContext, source_video_id: str) -> dict | None:
    try:
        data = json.loads(_cuts_info_path(ctx, source_video_id).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def _write_cuts_info(ctx: JobContext, source_video_id: str, info: dict) -> None:
    path = _cuts_info_path(ctx, source_video_id)
    tmp = path.with_name("cuts.part.json")
    tmp.write_text(json.dumps(info), encoding="utf-8")
    tmp.replace(path)


def clip_cuts(ctx: JobContext, source: dict, start: float, end: float) -> list[float]:
    """Exact shot changes inside [start, end] of a source. Import only reads keyframes (fast, good enough
    for the pacing score); where a crop has to switch on the cut, the clip's own stretch is examined frame
    by frame here, once, and remembered."""
    stored = [float(c) for c in (source.get("scene_cuts") or []) if start <= float(c) <= end]
    info = _read_cuts_info(ctx, source["id"])
    if not info or info.get("mode") != "coarse":
        return stored
    windows = [w for w in info.get("windows") or [] if isinstance(w, dict)]
    for w in windows:
        if float(w.get("s", 1e18)) <= start + 1e-3 and float(w.get("e", -1)) >= end - 1e-3:
            return [float(c) for c in w.get("cuts") or [] if start <= float(c) <= end]
    try:
        cuts = ffmpeg.scene_cuts_between(source_file(ctx, source), start, end)
    except (ffmpeg.FfmpegError, PermanentError) as e:
        log.warning("exact shot changes for %.1f-%.1f s failed (%s); using the keyframe ones", start, end, e)
        return stored
    windows.append({"s": round(start, 3), "e": round(end, 3), "cuts": cuts})
    try:
        _write_cuts_info(ctx, source["id"], {**info, "windows": windows[-MAX_CUT_WINDOWS:]})
    except OSError:
        pass
    return cuts


def ingest(ctx: JobContext, source_video_id: str) -> dict:
    db = ctx.db
    source = db.get("source_videos", source_video_id)
    if source is None:
        raise PermanentError("source video not found")
    path = source_file(ctx, source)

    ctx.progress(0.02, "Probing video")
    if not source.get("duration_sec"):
        info = ffmpeg.probe(path)
        if info["duration"] <= 0:
            raise PermanentError("could not read video duration")
        db.update(
            "source_videos",
            source_video_id,
            {
                "duration_sec": info["duration"],
                "width": info["width"],
                "height": info["height"],
                "fps": info["fps"],
                "size_bytes": info["size_bytes"] or path.stat().st_size,
            },
        )

    audio_key = source.get("audio_key") or f"sources/{source_video_id}/audio.wav"
    audio_path = ctx.settings.storage_path(audio_key)
    if not audio_path.exists() or audio_path.stat().st_size < 1000:
        ctx.progress(0.05, "Extracting audio")
        tmp = audio_path.with_suffix(".part.wav")
        ffmpeg.extract_audio(path, tmp, lambda p: ctx.progress(0.05 + 0.45 * p))
        tmp.replace(audio_path)
    db.update("source_videos", source_video_id, {"audio_key": audio_key})

    thumb_key = f"sources/{source_video_id}/thumb.jpg"
    thumb_path = ctx.settings.storage_path(thumb_key)
    if not thumb_path.exists():
        try:
            dur = float(db.get("source_videos", source_video_id)["duration_sec"] or 0)  # type: ignore[index]
            tmp_thumb = thumb_path.with_name("thumb.part.jpg")
            ffmpeg.extract_frame(path, dur * 0.1, tmp_thumb)
            tmp_thumb.replace(thumb_path)
        except Exception as e:  # noqa: BLE001 - a missing thumbnail must not fail ingest
            log.warning("thumbnail failed: %s", e)

    if source.get("scene_cuts") is None:
        ctx.progress(0.5, "Detecting shot changes")
        dur = float(db.get("source_videos", source_video_id)["duration_sec"] or 0)  # type: ignore[index]
        cuts, mode = ffmpeg.quick_scene_cuts(path, dur, on_progress=lambda p: ctx.progress(0.5 + 0.4 * p))
        _write_cuts_info(ctx, source_video_id, {"mode": mode, "windows": []})
        db.update("source_videos", source_video_id, {"scene_cuts": cuts})

    # older sources only have loudness; the hype score also wants brightness and spectral change
    if source.get("energy") is None or int((source.get("energy") or {}).get("v") or 1) < ffmpeg.ENERGY_VERSION:
        ctx.progress(0.92, "Measuring loudness")
        db.update("source_videos", source_video_id, {"energy": ffmpeg.audio_energy(audio_path)})

    db.update("source_videos", source_video_id, {"status": "ready", "error": None})
    ctx.progress(1.0, "Ingested", force=True)
    return db.get("source_videos", source_video_id)  # type: ignore[return-value]


def handle_ingest(ctx: JobContext) -> dict:
    src = ingest(ctx, ctx.payload["source_video_id"])
    return {"source_video_id": src["id"], "duration_sec": src["duration_sec"]}
