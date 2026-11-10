"""Thin ffmpeg/ffprobe wrappers. Uses the system binaries when present and
falls back to the bundled static build (downloaded once by static-ffmpeg)."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import wave
from functools import lru_cache
from pathlib import Path
from typing import Callable, Optional

import numpy as np


class FfmpegError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def binaries() -> tuple[str, str]:
    ff, fp = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if ff and fp:
        return ff, fp
    from static_ffmpeg import run as sff  # lazy: triggers a one-time download

    ff, fp = sff.get_or_fetch_platform_executables_else_raise()
    return ff, fp


def run_ffmpeg(
    args: list[str],
    *,
    duration: Optional[float] = None,
    on_progress: Optional[Callable[[float], None]] = None,
) -> str:
    """Run ffmpeg; returns stderr. Reports 0..1 progress when duration is known."""
    cmd = [binaries()[0], "-hide_banner", "-nostdin", "-y", *args]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace")
    tail: list[str] = []
    assert proc.stderr is not None
    for line in proc.stderr:
        tail.append(line)
        if len(tail) > 400:
            del tail[:200]
        if on_progress and duration:
            m = re.search(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", line)
            if m:
                t = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
                on_progress(min(1.0, t / duration))
    code = proc.wait()
    out = "".join(tail)
    if code != 0:
        raise FfmpegError(f"ffmpeg exited {code}: {out[-1500:]}")
    return out


def probe(path: Path | str) -> dict:
    cmd = [binaries()[1], "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)]
    res = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if res.returncode != 0:
        raise FfmpegError(f"ffprobe failed: {res.stderr[-800:]}")
    data = json.loads(res.stdout)
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if v is None:
        raise FfmpegError("no video stream found")
    fmt = data.get("format", {})
    duration = float(fmt.get("duration") or v.get("duration") or 0)
    w, h = int(v["width"]), int(v["height"])
    # Phone footage is often stored sideways with a rotation flag.
    rotation = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    if abs(rotation) in (90, 270):
        w, h = h, w
    return {
        "duration": duration,
        "width": w,
        "height": h,
        "fps": _ratio(v.get("avg_frame_rate") or v.get("r_frame_rate") or "30/1"),
        "video_codec": v.get("codec_name"),
        "audio_codec": a.get("codec_name") if a else None,
        "has_audio": a is not None,
        "size_bytes": int(fmt.get("size") or 0),
        "format_tags": fmt.get("tags", {}),
    }


def _ratio(s: str) -> float:
    try:
        n, _, d = s.partition("/")
        return round(float(n) / float(d or 1), 3) if float(d or 1) else 30.0
    except ValueError:
        return 30.0


def extract_audio(src: Path, dst_wav: Path, on_progress: Optional[Callable[[float], None]] = None) -> None:
    """16 kHz mono PCM – what Whisper wants."""
    info = probe(src)
    if not info["has_audio"]:
        # Silent source: synthesize silence so downstream steps still work.
        run_ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", f"{max(0.1, info['duration']):.3f}",
                    "-c:a", "pcm_s16le", str(dst_wav)])
        return
    run_ffmpeg(
        ["-i", str(src), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(dst_wav)],
        duration=info["duration"],
        on_progress=on_progress,
    )


def scene_cuts(src: Path, threshold: float = 0.32, on_progress: Optional[Callable[[float], None]] = None) -> list[float]:
    """Timestamps (s) of shot changes via ffmpeg's scene score on a small proxy."""
    info = probe(src)
    out = run_ffmpeg(
        ["-i", str(src), "-an", "-vf", f"fps=10,scale=320:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
        duration=info["duration"],
        on_progress=on_progress,
    )
    cuts = sorted({round(float(m), 3) for m in re.findall(r"pts_time:([0-9.]+)", out)})
    # collapse cuts closer than 0.5 s (flashes, dissolves)
    merged: list[float] = []
    for c in cuts:
        if not merged or c - merged[-1] >= 0.5:
            merged.append(c)
    return merged


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
        ch = wf.getnchannels()
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        audio = audio.reshape(-1, ch).mean(axis=1)
    return audio, sr


def audio_energy(wav: Path, hop: float = 0.5) -> dict:
    """RMS loudness per hop, normalised to 0..1 against the 95th percentile."""
    audio, sr = read_wav(wav)
    n = max(1, int(sr * hop))
    frames = len(audio) // n
    if frames == 0:
        return {"hop": hop, "rms": []}
    rms = np.sqrt((audio[: frames * n].reshape(frames, n) ** 2).mean(axis=1))
    ref = float(np.percentile(rms, 95)) or 1.0
    return {"hop": hop, "rms": [round(float(x), 4) for x in np.clip(rms / ref, 0, 1)]}


def extract_frame(src: Path, t: float, dst: Path, width: int = 540) -> None:
    run_ffmpeg(["-ss", f"{max(0, t):.3f}", "-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "3", str(dst)])
