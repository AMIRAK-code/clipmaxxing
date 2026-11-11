"""Render: Remotion (node) -> loudness-normalised, faststart MP4 in storage.

handle_render payload: {render_id}. The renders row already exists (status
'queued'; options {denoise?, voiceover_key?}). The video stream coming out of
Remotion is COPIED by the post-process: only audio is re-encoded."""
from __future__ import annotations

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

from .. import ffmpeg
from ..config import REPO_ROOT
from ..db import now_iso
from ..runner import JobCancelled, JobContext, PermanentError
from .ingest import source_file
from .reframe import reframe, words_in_range
from .voiceover import audio_duration

log = logging.getLogger("klipz.render")

RENDER_MJS = REPO_ROOT / "packages" / "video" / "render.mjs"
TARGET_LUFS, TARGET_TP, TARGET_LRA = -14.0, -1.5, 11.0
COVER_FRAME = 24
_TRANSIENT = re.compile(r"No frame found at position|Compositor error", re.I)
_BAD_INPUT = re.compile(r"props|sourceUrl|usage:|not absolute", re.I)


_STAGES = {"bundling": "Preparing renderer", "rendering": "Rendering video", "encoding": "Encoding"}


class RenderError(RuntimeError):
    pass


# ── props ────────────────────────────────────────────────────────────────────
def build_props(ctx: JobContext, clip: dict[str, Any], source: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
    db = ctx.db
    if not (source.get("width") and source.get("height")):
        raise PermanentError("source has no dimensions; run ingest first")
    props: dict[str, Any] = {
        "sourceUrl": source["storage_key"],
        "srcW": int(source["width"]),
        "srcH": int(source["height"]),
        "cropTrack": clip.get("crop_track"),
        "assetBaseUrl": "",
    }
    style_id = clip.get("caption_style_id")
    if style_id:
        row = db.get("caption_styles", style_id)
        if row:
            style = row["style"] if isinstance(row["style"], dict) else json.loads(row["style"])
            props["customStyles"] = [{**style, "id": row["id"], "name": style.get("name", row["name"])}]
    edit = clip.get("edit_state")
    if edit:
        edit = json.loads(json.dumps(edit))
        vo = options.get("voiceover_key")
        if vo and not any(a.get("src") == vo for a in edit.get("audio") or []):
            try:
                dur = audio_duration(ctx.settings.storage_path(vo))
            except Exception as e:  # noqa: BLE001
                raise PermanentError(f"voiceover file unreadable: {vo} ({e})") from e
            edit.setdefault("audio", []).append({
                "id": "voiceover-render", "src": vo, "kind": "voiceover", "start": 0, "duration": dur,
                "srcOffset": 0, "volume": 1.0, "duck": True,
            })
        props["edit"] = edit
    else:
        if options.get("voiceover_key"):
            log.warning("voiceover_key ignored: clip %s has no edit_state to attach it to", clip["id"])
        transcript = db.one("transcripts", "select * from transcripts where source_video_id = ?", source["id"])
        c: dict[str, Any] = {
            "start": clip["start_sec"],
            "end": clip["end_sec"],
            "words": words_in_range(transcript, float(clip["start_sec"]), float(clip["end_sec"])),
            "keywords": (clip.get("score_breakdown") or {}).get("keywords") or [],
        }
        if clip.get("hook"):
            c["hook"] = clip["hook"]
        if style_id:
            c["styleId"] = style_id
        props["clip"] = c
        # Explicit null: the composition's defaultProps carry an `edit`, which would otherwise
        # shadow `clip` in normalizeProps (observed: every clip rendered as the 4.4 s default).
        props["edit"] = None
    return props


# ── node ─────────────────────────────────────────────────────────────────────
def kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
        else:
            import signal

            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001
        proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def find_node() -> str:
    node = shutil.which("node")
    if not node:
        raise PermanentError("Node.js is required to render clips but 'node' was not found on PATH")
    return node


def run_remotion(
    ctx: JobContext, props_path: Path, out: Path, cover: Path, *, argv_prefix: Optional[list[str]] = None,
    on_progress: Optional[Callable[[float, Optional[str]], None]] = None,
) -> dict[str, Any]:
    """Run render.mjs, stream its JSON lines, return the 'done' record."""
    cmd = list(argv_prefix) if argv_prefix else [find_node(), str(RENDER_MJS)]
    cmd += ["--props", str(props_path), "--out", str(out), "--storage", str(ctx.settings.storage_dir),
            "--cover", str(cover), "--cover-frame", str(COVER_FRAME)]
    conc = os.environ.get("KLIPZ_RENDER_CONCURRENCY", "").strip()
    if conc.isdigit():
        cmd += ["--concurrency", conc]
    err_path = out.with_suffix(".stderr.log")
    kwargs: dict[str, Any] = {}
    if sys.platform != "win32":
        kwargs["start_new_session"] = True
    with open(err_path, "wb") as err_f:
        proc = subprocess.Popen(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=err_f, stdin=subprocess.DEVNULL,
                                text=True, encoding="utf-8", errors="replace", **kwargs)
        lines: "queue.Queue[Optional[str]]" = queue.Queue()

        def pump() -> None:
            assert proc.stdout is not None
            for ln in proc.stdout:
                lines.put(ln)
            lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        done: Optional[dict[str, Any]] = None
        error: Optional[str] = None
        frac, stage = 0.0, None
        try:
            while True:
                try:
                    ln = lines.get(timeout=1.0)
                except queue.Empty:
                    ctx.progress(frac)  # also notices cancellation while node is quiet
                    continue
                if ln is None:
                    break
                try:
                    msg = json.loads(ln)
                except json.JSONDecodeError:
                    continue
                kind = msg.get("type")
                if kind == "progress":
                    frac, stage = float(msg.get("progress", 0.0)), msg.get("stage")
                    if on_progress:
                        on_progress(frac, stage)
                    else:
                        ctx.progress(frac, _STAGES.get(stage or "", stage))
                elif kind == "done":
                    done = msg
                elif kind == "error":
                    error = str(msg.get("message") or "render failed")
            code = proc.wait()
        except JobCancelled:
            kill_tree(proc)
            raise
        except BaseException:
            kill_tree(proc)
            raise
    tail = ""
    try:
        tail = err_path.read_text(encoding="utf-8", errors="replace")[-1500:]
    except OSError:
        pass
    finally:
        err_path.unlink(missing_ok=True)
    if error is not None:
        raise RenderError(error) if not _BAD_INPUT.search(error) else PermanentError(error)
    if code != 0 or done is None:
        raise RenderError(f"render process exited with code {code}: {tail.strip()[-600:]}")
    return done


# ── audio post-process ──────────────────────────────────────────────────────
_JSON_RE = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.S)


def measure_loudness(path: Path, prefilter: str = "") -> dict[str, float]:
    """EBU R128 measurement via loudnorm's analysis pass."""
    af = f"{prefilter}loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}:print_format=json"
    err = ffmpeg.run_ffmpeg(["-i", str(path), "-vn", "-af", af, "-f", "null", "-"])
    m = _JSON_RE.search(err)
    if not m:
        raise RenderError("loudness measurement produced no result")
    raw = json.loads(m.group(0))
    return {k: float(v) for k, v in raw.items() if re.fullmatch(r"-?inf|-?[0-9.]+", str(v))}


def finalize(src: Path, dst: Path, *, denoise: bool = False) -> Optional[float]:
    """Copy video, loudnorm audio to -14 LUFS (two-pass), AAC 192k/48k, faststart.
    Returns the measured integrated loudness of the result (None when silent)."""
    info = ffmpeg.probe(src)
    pre = "afftdn=nf=-25," if denoise else ""
    base = ["-i", str(src), "-map", "0:v:0", "-c:v", "copy"]
    tail = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(dst)]
    if not info["has_audio"]:
        ffmpeg.run_ffmpeg(["-i", str(src), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-map", "0:v:0",
                           "-map", "1:a:0", "-c:v", "copy", "-shortest", *tail])
        return None
    m = measure_loudness(src, pre)
    if not (m.get("input_i", float("-inf")) > -70.0):
        af = pre.rstrip(",") or "anull"  # silent audio: nothing to normalise
        ffmpeg.run_ffmpeg([*base, "-map", "0:a:0", "-af", af, *tail])
        return None
    af = (f"{pre}loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA={TARGET_LRA}:measured_I={m['input_i']}:"
          f"measured_LRA={m['input_lra']}:measured_TP={m['input_tp']}:measured_thresh={m['input_thresh']}:"
          f"offset={m['target_offset']}:linear=true,aresample=48000")
    ffmpeg.run_ffmpeg([*base, "-map", "0:a:0", "-af", af, *tail])
    return round(measure_loudness(dst)["input_i"], 2)


def verify_output(path: Path) -> dict[str, Any]:
    info = ffmpeg.probe(path)
    problems = []
    if (info["width"], info["height"]) != (1080, 1920):
        problems.append(f"size {info['width']}x{info['height']}")
    if info["video_codec"] != "h264":
        problems.append(f"video codec {info['video_codec']}")
    if info["audio_codec"] != "aac":
        problems.append(f"audio codec {info['audio_codec']}")
    if problems:
        raise RenderError("unexpected render output: " + ", ".join(problems))
    return info


# ── handler ──────────────────────────────────────────────────────────────────
def render_clip(ctx: JobContext, render_id: str) -> dict[str, Any]:
    db = ctx.db
    render = db.get("renders", render_id)
    if render is None:
        raise PermanentError("render not found")
    if render["status"] == "ready" and render.get("storage_key") and ctx.settings.storage_path(render["storage_key"]).exists():
        ctx.progress(1.0, "Already rendered", force=True)
        return {"render_id": render_id, "storage_key": render["storage_key"], "skipped": True}
    work = ctx.settings.data_dir / "tmp" / f"render-{render_id}"
    try:
        clip = db.get("clips", render["clip_id"])
        if clip is None:
            raise PermanentError("clip not found")
        source = db.get("source_videos", clip["source_video_id"])
        if source is None:
            raise PermanentError("source video not found")
        source_file(ctx, source)  # raises PermanentError when the media is gone
        options = render.get("options") or {}

        db.update("renders", render_id, {"status": "rendering", "error": None})
        ctx.progress(0.0, "Preparing render", force=True)
        if not clip.get("crop_track"):
            reframe(ctx.sub(0.0, 0.12), clip["id"])
            clip = db.get("clips", clip["id"])  # type: ignore[assignment]
        # version of the edit the props are built from (not an earlier read: autosave may land meanwhile)
        edit_version = int(clip.get("edit_version") or 0)
        props = build_props(ctx, clip, source, options)

        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        props_path = work / "props.json"
        props_path.write_text(json.dumps(props), encoding="utf-8")
        raw, cover = work / "raw.mp4", work / "cover.jpg"
        sub = ctx.sub(0.12, 0.85)
        for attempt in (1, 2):
            try:
                run_remotion(sub, props_path, raw, cover)
                break
            except RenderError as e:
                if attempt == 2 or not _TRANSIENT.search(str(e)):
                    raise
                log.warning("transient render error, retrying: %s", e)
        ctx.progress(0.86, "Normalising audio", force=True)
        final = work / "final.mp4"
        lufs = finalize(raw, final, denoise=bool(options.get("denoise")))
        info = verify_output(final)
        ctx.progress(0.96, "Saving", force=True)
        key, cover_key = f"renders/{render_id}/clip.mp4", f"renders/{render_id}/cover.jpg"
        dest, dest_cover = ctx.settings.storage_path(key), ctx.settings.storage_path(cover_key)
        part = dest.with_name("clip.part.mp4")
        shutil.copyfile(final, part)
        os.replace(part, dest)
        if not cover.exists():
            ffmpeg.extract_frame(dest, 1.0, cover, width=540)
        cpart = dest_cover.with_name("cover.part.jpg")
        shutil.copyfile(cover, cpart)
        os.replace(cpart, dest_cover)
        db.update("renders", render_id, {
            "status": "ready", "storage_key": key, "cover_key": cover_key, "width": info["width"],
            "height": info["height"], "fps": info["fps"], "duration_sec": round(info["duration"], 3),
            "size_bytes": dest.stat().st_size, "video_codec": info["video_codec"], "audio_codec": info["audio_codec"],
            "lufs": lufs, "edit_version": edit_version, "completed_at": now_iso(), "error": None,
        })
    except JobCancelled:
        db.update("renders", render_id, {"status": "failed", "error": "Cancelled"})
        raise
    except PermanentError as e:
        db.update("renders", render_id, {"status": "failed", "error": str(e)[:1000]})
        raise
    except Exception as e:  # noqa: BLE001
        final_attempt = ctx.job["attempts"] >= ctx.job["max_attempts"]
        db.update("renders", render_id, {"status": "failed" if final_attempt else "queued", "error": str(e)[:1000]})
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
    ctx.progress(1.0, "Rendered", force=True)
    return {"render_id": render_id, "storage_key": key, "lufs": lufs, "duration_sec": round(info["duration"], 3)}


def handle_render(ctx: JobContext) -> dict[str, Any]:
    rid = ctx.payload.get("render_id")
    if not rid:
        raise PermanentError("payload.render_id is required")
    return render_clip(ctx, rid)


HANDLERS = {"render": handle_render}
