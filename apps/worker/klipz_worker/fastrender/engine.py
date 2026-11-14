"""The fast renderer: one FFmpeg run instead of a browser drawing every frame.

    reason = unsupported_reason(props)        # None -> the fast renderer can draw this edit
    render(props, source, out, work, ...)     # writes an H.264/AAC 1080x1920 mp4

It draws what the Remotion composition draws for the common case (cuts, crop / letterbox / split
reframing, zoom keys, word captions in the built-in styles, hook card, progress bar). Edits that use
anything else (b-roll, extra audio, text overlays, piece transitions, looks, emoji captions, fonts that
are not bundled) are reported as unsupported and rendered by Remotion as before.
"""
from __future__ import annotations

import functools
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Optional

from . import model as m
from .ass import Unsupported, build_ass, hook_dim
from .graph import FPS, build_plan
from .text import font_files

log = logging.getLogger("klipz.fastrender")

DEFAULT_PRESET = "veryfast"
X264_PRESETS = ("ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow")


def _edit_of(props: dict[str, Any]) -> dict[str, Any]:
    edit = props.get("edit")
    if not isinstance(edit, dict) or not edit.get("video"):
        raise Unsupported("the clip has no saved edit (it is rendered from defaults by the Studio renderer)")
    return edit


def unsupported_reason(props: dict[str, Any]) -> Optional[str]:
    """Why the fast renderer cannot draw this edit, or None when it can."""
    try:
        edit = _edit_of(props)
        if (edit.get("look") or "none") != "none":
            return f"the '{edit.get('look')}' look is drawn by the Studio renderer only"
        if edit.get("broll"):
            return "b-roll is drawn by the Studio renderer only"
        if edit.get("audio"):
            return "added audio (music / voiceover) is mixed by the Studio renderer only"
        if edit.get("texts"):
            return "text overlays are drawn by the Studio renderer only"
        for p in edit["video"]:
            tr = p.get("transitionIn")
            if tr and tr.get("type") not in (None, "none"):
                return "piece transitions are drawn by the Studio renderer only"
            if not (float(p["srcEnd"]) > float(p["srcStart"]) >= 0):
                return "a video piece has an invalid range"
        if not (int(props.get("srcW") or 0) > 0 and int(props.get("srcH") or 0) > 0):
            return "the source size is unknown"
        total = m.duration_in_frames(edit["video"])
        build_ass(edit, props.get("customStyles") or [], total)  # raises Unsupported for captions it cannot draw
    except Unsupported as e:
        return str(e)
    except Exception as e:  # noqa: BLE001 - malformed edit: let the Studio renderer report it properly
        return f"the edit could not be read by the fast renderer ({type(e).__name__}: {e})"
    return None


_BT601 = {"smpte170m", "bt470bg", "bt470m", "smpte240m", "fcc"}
_HDR_TRANSFER = {"smpte2084", "arib-std-b67"}


def source_color(ffprobe: str, path: Path) -> tuple[str, bool]:
    """(matrix, full_range) the source must be read with, decided the way Chrome does: the tag when there
    is one, otherwise BT.709 for HD and BT.601 for SD. Raises Unsupported for HDR / wide-gamut video."""
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=height,pix_fmt,color_space,color_range,color_transfer", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=60).stdout
        st = (json.loads(out).get("streams") or [{}])[0]
    except Exception as e:  # noqa: BLE001
        raise Unsupported(f"the source could not be probed ({e})") from e
    space = str(st.get("color_space") or "unknown").lower()
    if str(st.get("color_transfer") or "").lower() in _HDR_TRANSFER or space.startswith("bt2020"):
        raise Unsupported("HDR / BT.2020 video is rendered by the Studio renderer only")
    if space == "bt709":
        matrix = "bt709"
    elif space in _BT601:
        matrix = "bt601"
    else:
        matrix = "bt709" if int(st.get("height") or 0) >= 720 else "bt601"
    pix = str(st.get("pix_fmt") or "")
    return matrix, str(st.get("color_range") or "").lower() in ("pc", "jpeg") or pix.startswith("yuvj")


@functools.lru_cache(maxsize=4)
def _ffmpeg_major(ffmpeg: str) -> Optional[int]:
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-version"], capture_output=True, text=True, timeout=15).stdout
    except Exception:  # noqa: BLE001
        return None
    mm = re.search(r"ffmpeg version n?(\d+)\.", out)
    return int(mm.group(1)) if mm else None


def _kill(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            proc.kill()
    except Exception:  # noqa: BLE001
        proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def render(
    props: dict[str, Any],
    source_path: Path,
    out: Path,
    work: Path,
    *,
    ffmpeg: str,
    ffprobe: str,
    has_audio: bool,
    on_progress: Optional[Callable[[float], None]] = None,
) -> dict[str, Any]:
    """Render `props` (the same props the Remotion renderer gets) to `out`. `on_progress(0..1)` may raise
    to cancel; the FFmpeg process is always stopped before this returns or raises."""
    edit = _edit_of(props)
    total = m.duration_in_frames(edit["video"])
    work.mkdir(parents=True, exist_ok=True)

    ass_name: Optional[str] = None
    ass = build_ass(edit, props.get("customStyles") or [], total, draw_dim=False)
    if ass:
        ass_name = "captions.ass"
        (work / ass_name).write_text(ass, encoding="utf-8")
        fonts = work / "fonts"
        fonts.mkdir(exist_ok=True)
        for f in font_files():
            shutil.copyfile(f, fonts / f.name)

    matrix, full_range = source_color(ffprobe, source_path)
    plan = build_plan(props, str(source_path), has_audio=has_audio, ass_file=ass_name, matrix=matrix, full_range=full_range,
                      dim=hook_dim(edit, total))
    for name, content in plan.files.items():
        (work / name).write_text(content, encoding="utf-8")
    (work / "graph.txt").write_text(plan.graph, encoding="utf-8")

    preset = os.environ.get("KLIPZ_FAST_PRESET", "").strip().lower()
    if preset not in X264_PRESETS:
        preset = DEFAULT_PRESET
    major = _ffmpeg_major(ffmpeg)
    graph_arg = ["-filter_complex_script", "graph.txt"] if major is not None and major < 7 else ["-/filter_complex", "graph.txt"]
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1"]
    for inp in plan.inputs:
        cmd += inp
    cmd += [
        *graph_arg, "-map", f"[{plan.video_out}]", "-map", f"[{plan.audio_out}]",
        "-c:v", "libx264", "-preset", preset, "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-frames:v", str(total), "-t", f"{total / FPS:.6f}", "-movflags", "+faststart", str(out),
    ]
    err_path = work / "ffmpeg.stderr.log"
    with open(err_path, "wb") as err_f:
        proc = subprocess.Popen(cmd, cwd=str(work), stdout=subprocess.PIPE, stderr=err_f, stdin=subprocess.DEVNULL,
                                text=True, encoding="utf-8", errors="replace")
        lines: "queue.Queue[Optional[str]]" = queue.Queue()

        def pump() -> None:
            assert proc.stdout is not None
            for ln in proc.stdout:
                lines.put(ln)
            lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        frac = 0.0
        try:
            while True:
                try:
                    ln = lines.get(timeout=1.0)
                except queue.Empty:
                    if on_progress:
                        on_progress(frac)  # also lets the caller cancel while ffmpeg is quiet
                    continue
                if ln is None:
                    break
                if ln.startswith("frame="):
                    try:
                        frac = min(1.0, int(ln.split("=", 1)[1]) / max(1, total))
                    except ValueError:
                        continue
                    if on_progress:
                        on_progress(frac)
            code = proc.wait()
        finally:
            _kill(proc)
    if code != 0 or not out.exists() or out.stat().st_size == 0:
        tail = err_path.read_text(encoding="utf-8", errors="replace")[-1500:].strip()
        raise RuntimeError(f"ffmpeg exited {code}: {tail or 'no error output'}")
    return {"frames": total, "preset": preset}
