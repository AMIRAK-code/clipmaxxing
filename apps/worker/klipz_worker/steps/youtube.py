"""YouTube import via yt-dlp. Downloads ≤1080p MP4 into storage, then hands
off to ingest. Only import videos you own or have the right to reuse."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Callable, Optional

from .. import ffmpeg
from ..runner import JobCancelled, JobContext, PermanentError
from .ingest import ingest

YOUTUBE_RE = re.compile(
    r"^https?://(?:www\.|m\.|music\.)?(?:youtube\.com/(?:watch\?[^#]*v=|shorts/|live/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})"
)


def parse_video_id(url: str) -> Optional[str]:
    m = YOUTUBE_RE.match(url.strip())
    return m.group(1) if m else None


def download(url: str, dest_dir: Path, on_progress: Callable[[float], None]) -> tuple[Path, dict]:
    import yt_dlp

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                on_progress(min(0.99, d.get("downloaded_bytes", 0) / total))

    opts = {
        "format": "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(dest_dir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "ffmpeg_location": str(Path(ffmpeg.binaries()[0]).parent),
        "retries": 3,
        "overwrites": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = sorted(dest_dir.glob("source.*"), key=lambda p: p.stat().st_size, reverse=True)
    files = [f for f in files if f.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")]
    if not files:
        raise RuntimeError("yt-dlp finished but produced no video file")
    return files[0], info or {}


def handle_import_youtube(ctx: JobContext) -> dict:
    db = ctx.db
    sid = ctx.payload["source_video_id"]
    source = db.get("source_videos", sid)
    if source is None:
        raise PermanentError("source video not found")
    url = source.get("source_url") or ctx.payload.get("url") or ""
    if not parse_video_id(url):
        db.update("source_videos", sid, {"status": "failed", "error": "Not a valid YouTube URL"})
        raise PermanentError("not a valid YouTube URL")

    key = source.get("storage_key")
    if not key or not ctx.settings.storage_path(key).exists():
        db.update("source_videos", sid, {"status": "importing", "error": None})
        ctx.progress(0.01, "Downloading from YouTube")
        dest_dir = ctx.settings.storage_path(f"sources/{sid}/source.mp4").parent
        dl = ctx.sub(0.0, 0.7)
        try:
            path, info = download(url, dest_dir, lambda p: dl.progress(p))
        except JobCancelled:
            raise
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            permanent = any(s in msg for s in ("Private video", "Video unavailable", "Sign in to confirm", "members-only"))
            if permanent or ctx.job["attempts"] >= ctx.job["max_attempts"]:
                db.update("source_videos", sid, {"status": "failed", "error": msg[:500]})
            if permanent:
                raise PermanentError(msg) from e
            raise
        key = f"sources/{sid}/{path.name}"
        db.update("source_videos", sid, {"storage_key": key, "filename": (info.get("title") or "YouTube video")[:200]})
        title = info.get("title")
        if title and source.get("project_id"):
            proj = db.get("projects", source["project_id"])
            if proj and proj["title"] in ("", "Untitled", "YouTube import"):
                db.update("projects", proj["id"], {"title": title[:120]})

    src = ingest(ctx.sub(0.7, 1.0), sid)
    then = ctx.payload.get("then")
    if then in ("analyze", "autoclip"):
        db.enqueue(then, {"source_video_id": sid, **(ctx.payload.get("then_payload") or {})},
                   project_id=source["project_id"], dedupe_key=f"{then}:{sid}", parent_job_id=ctx.job["id"])
    return {"source_video_id": sid, "duration_sec": src["duration_sec"]}
