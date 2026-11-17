"""YouTube import via yt-dlp. Downloads an MP4 (1080p, 720p or 480p) into storage, then hands
off to ingest. Only import videos you own or have the right to reuse."""
from __future__ import annotations

import re
import shutil
import time
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


QUALITIES = ("auto", "1080", "720", "480")
AUTO_LONG_SECONDS = 3600  # "auto": 1080p up to an hour, 720p beyond (half the download for a long stream)

ProgressFn = Callable[[float, Optional[str]], None]


def pick_height(quality: Optional[str], duration: Optional[float]) -> int:
    q = str(quality or "auto").lower().rstrip("p")
    if q in ("1080", "720", "480"):
        return int(q)
    return 720 if duration and float(duration) > AUTO_LONG_SECONDS else 1080


def format_selector(height: int) -> str:
    h = f"[height<={height}]"
    return f"bv*{h}[ext=mp4]+ba[ext=m4a]/b{h}[ext=mp4]/bv*{h}+ba/b{h}/b"


def human_bytes(n: float) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB" if n >= 1e6 else f"{max(0.0, n) / 1e3:.0f} KB"


def human_left(seconds: float) -> str:
    s = int(max(0.0, seconds) + 0.5)
    if s < 60:
        return f"{max(1, s)} s left"
    if s < 3600:
        return f"{round(s / 60)} min left"
    return f"{s // 3600} h {s % 3600 // 60} min left"


def _expected_size(fmt: dict, duration: Optional[float]) -> float:
    size = fmt.get("filesize") or fmt.get("filesize_approx")
    if not size and fmt.get("tbr") and duration:
        size = float(fmt["tbr"]) * 1000 / 8 * float(duration)
    return float(size or 0)


class DownloadProgress:
    """Turns yt-dlp's per-file progress events into one honest number for the whole import.

    A video usually arrives as two files (picture, then sound). yt-dlp reports each on its own, so the
    bar used to run to 99 %, jump back for the second file, and say nothing about size, speed or time.
    Here the sizes of all the files are added up front (from the format list), bytes are counted across
    them, the fraction never goes backwards, and the text carries MB done / total, speed and time left."""

    DOWNLOAD_SHARE = 0.97  # the rest is joining picture and sound

    def __init__(self, emit: ProgressFn, clock: Callable[[], float] = time.monotonic):
        self.emit, self.clock = emit, clock
        self.expect: dict[str, float] = {}
        self.alias: dict[str, str] = {}
        self.files: dict[str, tuple[float, float]] = {}
        self.samples: list[tuple[float, float]] = []
        self.fraction = 0.0
        self.last_text = -1e9

    def plan(self, info: dict) -> None:
        """The files this download will fetch (yt-dlp's chosen formats), so the total is known from the start."""
        for f in info.get("requested_formats") or [info]:
            self.expect.setdefault(str(f.get("format_id")), _expected_size(f, info.get("duration")))

    def _key(self, fid: str) -> str:
        """The planned file an event belongs to: by format id, else the next planned file not started yet."""
        if fid in self.expect:
            return fid
        if fid not in self.alias:
            taken = set(self.alias.values()) | set(self.files)
            self.alias[fid] = next((k for k in self.expect if k not in taken), fid)
        return self.alias[fid]

    def totals(self) -> tuple[float, float]:
        done = sum(d for d, _ in self.files.values())
        total = sum(max(self.files.get(k, (0.0, 0.0))[1], 0.0) or v for k, v in self.expect.items())
        return done, max(total, done)

    def speed(self, now: float, done: float) -> float:
        self.samples.append((now, done))
        while len(self.samples) > 2 and now - self.samples[0][0] > 5.0:
            self.samples.pop(0)
        t0, d0 = self.samples[0]
        return (done - d0) / (now - t0) if now - t0 >= 0.5 else 0.0

    def on_download(self, d: dict) -> None:
        status = d.get("status")
        if status not in ("downloading", "finished"):
            return
        info = d.get("info_dict") or {}
        fid = self._key(str(info.get("format_id") or d.get("filename") or "file"))
        done = float(d.get("downloaded_bytes") or 0)
        total = float(d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
        if status == "finished":
            total = total or done or self.files.get(fid, (0.0, 0.0))[1]
            done = total
        self.files[fid] = (done, total)
        self.expect.setdefault(fid, total)
        all_done, all_total = self.totals()
        if all_total <= 0:
            return
        self.fraction = max(self.fraction, self.DOWNLOAD_SHARE * min(1.0, all_done / all_total))
        now = self.clock()
        rate = self.speed(now, all_done)
        text = None
        if now - self.last_text >= 1.0 or status == "finished":
            self.last_text = now
            text = f"Downloading · {human_bytes(all_done)} of {human_bytes(all_total)}"
            if rate > 0 and all_done < all_total:
                text += f" · {human_bytes(rate)}/s · {human_left((all_total - all_done) / rate)}"
        self.emit(self.fraction, text)

    def on_postprocess(self, d: dict) -> None:
        if d.get("postprocessor") == "Merger" and d.get("status") == "started":
            self.fraction = max(self.fraction, self.DOWNLOAD_SHARE)
            self.emit(self.fraction, "Joining picture and sound")


def download(url: str, dest_dir: Path, on_progress: ProgressFn, quality: Optional[str] = "auto") -> tuple[Path, dict]:
    import yt_dlp

    base: dict = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 3,
    }
    # YouTube only offers its fast direct formats to clients that can run its player JavaScript. yt-dlp does
    # that with an external runtime; KLIPZ already ships Node (first on PATH in the desktop app).
    node = shutil.which("node")
    if node:
        base["js_runtimes"] = {"node": {"path": node}}

    on_progress(0.0, "Looking up the video")
    with yt_dlp.YoutubeDL(base) as ydl:  # one lookup: the length decides the quality for "auto"
        found = ydl.extract_info(url, download=False, process=False)
    height = pick_height(quality, (found or {}).get("duration"))

    tracker = DownloadProgress(on_progress)
    opts = {
        **base,
        # Fragmented (HLS/DASH-segment) streams are fetched one piece at a time by default, which made a
        # 2 GB import take 15+ minutes. Fetch 8 pieces in parallel, and ask for plain https in 10 MiB ranges
        # (YouTube throttles a single long request). Measured: 31 MB/s on one connection, the line's limit.
        "concurrent_fragment_downloads": 8,
        "http_chunk_size": 10 * 1024 * 1024,
        "fragment_retries": 5,
        "format": format_selector(height),
        "merge_output_format": "mp4",
        "outtmpl": str(dest_dir / "source.%(ext)s"),
        "progress_hooks": [tracker.on_download],
        "postprocessor_hooks": [tracker.on_postprocess],
        "ffmpeg_location": str(Path(ffmpeg.binaries()[0]).parent),
        "overwrites": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        chosen = ydl.process_ie_result(found, download=False)  # picks the formats: their sizes are the total
        tracker.plan(chosen or {})
        info = ydl.process_ie_result(chosen, download=True)
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
        dest_dir = ctx.settings.storage_path(f"sources/{sid}/source.mp4").parent
        dl = ctx.sub(0.0, 0.85)
        try:
            path, info = download(url, dest_dir, lambda p, text=None: dl.progress(p, text), ctx.payload.get("quality"))
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

    src = ingest(ctx.sub(0.85, 1.0), sid)
    then = ctx.payload.get("then")
    if then in ("analyze", "autoclip"):
        db.enqueue(then, {"source_video_id": sid, **(ctx.payload.get("then_payload") or {})},
                   project_id=source["project_id"], dedupe_key=f"{then}:{sid}", parent_job_id=ctx.job["id"])
    return {"source_video_id": sid, "duration_sec": src["duration_sec"]}
