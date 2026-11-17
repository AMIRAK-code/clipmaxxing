"""Manual AI Mode: the person asks Gemini (or any chat AI) to pick the clips, then pastes its JSON back.

manual_export (job "manual_export", {project_id})
    Transcribes every video of the project with the local Whisper engine and writes, into
    storage/projects/<project id>/manual/:
      video_transcript.txt   timestamped transcript (one line per sentence, seconds), all videos
      video_light.mp4        a tiny proxy to upload: 360p, 1 fps, CRF 32, AAC 64k
                             (video_light_1.mp4, video_light_2.mp4 ... when there are several videos)
      gemini_prompt.txt      what to ask Gemini, with the exact JSON shape to answer in
    Then the workflow waits for the JSON.

manual_clips (job "manual_clips", {project_id, clips: [...]})
    The plan the web app parsed from the JSON (lib/gemini-plan.ts): clips of {title, hook, segments:
    [{source, start, end}]} in seconds of the ORIGINAL videos. For every clip the segments are cut from
    the original high-resolution video and joined (whatever lies between them is gone), with edges moved
    out of the middle of words; the clip gets the 9:16 crop (face tracking), word-timed captions and its
    hook card for the first HOOK_SECONDS, and is rendered. A one-video project gets ordinary clips of that
    video. A montage project goes through the scene-pool pipeline (steps/montage.py), so its clips mix
    videos and open in the editor's Scenes tab.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional, Sequence

from .. import ffmpeg
from ..runner import JobContext, PermanentError
from . import montage as mt
from . import segment as seg
from .ingest import ingest, source_file

log = logging.getLogger("klipz.manual_ai")

HOOK_SECONDS = 4.0
PROXY_HEIGHT = 360
PROXY_FPS = 1
DEFAULT_STYLE = "bold-outline"
MIN_SEGMENT = 0.3
MAX_CLIPS = 30
LINE_MAX = 10.0     # longest transcript line, seconds
LINE_PAUSE = 0.6   # a pause this long starts a new line


def manual_dir(project_id: str) -> str:
    return f"projects/{project_id}/manual"


def fmt_time(t: float) -> str:
    """Seconds as h:mm:ss.s for people; the transcript also gives plain seconds for the AI."""
    t = max(0.0, t)
    h, rest = divmod(t, 3600)
    m, s = divmod(rest, 60)
    return f"{int(h)}:{int(m):02d}:{s:04.1f}" if h else f"{int(m):02d}:{s:04.1f}"


def transcript_text(videos: Sequence[tuple[str, float, list[dict[str, Any]]]]) -> str:
    """One block per video: a header, then one line per sentence `[start - end] text` in seconds from the
    start of that video. Videos are numbered from 1, the same numbers the JSON's "video" field uses."""
    out: list[str] = []
    for i, (name, duration, words) in enumerate(videos, start=1):
        out.append(f"=== Video {i}: {name} (length {duration:.1f} s, {fmt_time(duration)}) ===")
        # short lines (a sentence, or at most LINE_MAX s of run-on speech) so the AI can cut precisely
        sentences = seg.build_sentences(list(words), pause=LINE_PAUSE, max_len=LINE_MAX)
        if not sentences:
            out.append("(no speech found)")
        for s in sentences:
            out.append(f"[{s.s:.2f} - {s.e:.2f}] {s.text}")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def prompt_text(videos: Sequence[tuple[str, float]], proxies: Sequence[str]) -> str:
    many = len(videos) > 1
    listing = "\n".join(f"  Video {i}: {name}, {d:.0f} s (proxy: {p})" for i, ((name, d), p) in enumerate(zip(videos, proxies), start=1))
    video_field = '"video": 1, ' if many else ""
    return f"""You are a short-form video editor. Attached: {"the light preview videos" if many else "a light preview video"} \
(360p, 1 frame per second, for viewing only) and video_transcript.txt, a transcript with start and end times in seconds.

{listing}

Find the best moments for vertical short videos (TikTok, Reels, Shorts): each one must hook in the first
seconds, make sense on its own and end on a complete thought. Each clip may join several segments; leave
out pauses, filler and anything that does not serve the clip. Use the transcript times (seconds from the
start of {"each" if many else "the"} video); never cut inside a sentence.{" Segments can come from different videos." if many else ""}

Answer with JSON only, no other text, in exactly this shape:
{{
  "clips": [
    {{
      "title": "short title",
      "text_on_screen": "hook shown for the first 4 seconds, at most 8 words",
      "segments": [
        {{ {video_field}"start": 12.4, "end": 19.8 }},
        {{ {video_field}"start": 31.0, "end": 44.2 }}
      ]
    }}
  ]
}}
{'"video" is the video number above (1, 2, ...). ' if many else ""}Clips of 15 to 60 seconds work best. Give 3 to 10 clips, best first.
"""


def proxy_args(src: Path, out: Path) -> list[str]:
    return [
        "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", f"scale=-2:{PROXY_HEIGHT},fps={PROXY_FPS}", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", str(out),
    ]


def inputs_of(db: Any, project_id: str) -> list[dict[str, Any]]:
    return db.many("source_videos", "select * from source_videos where project_id = ? and role = 'input' "
                   "and status not in ('deleted', 'failed', 'uploading') order by created_at", project_id)


def manual_export(ctx: JobContext, project_id: str) -> dict[str, Any]:
    from .transcribe import transcribe  # Whisper only when needed

    db = ctx.db
    if db.get("projects", project_id) is None:
        raise PermanentError("project not found")
    inputs = inputs_of(db, project_id)
    if not inputs:
        raise PermanentError("the project has no video yet")
    n = len(inputs)
    folder = ctx.settings.storage_path(manual_dir(project_id) + "/x").parent
    videos: list[tuple[str, float, list[dict[str, Any]]]] = []
    proxies: list[str] = []
    for i, src in enumerate(inputs):
        sub = ctx.sub(0.02 + 0.9 * i / n, 0.02 + 0.9 * (i + 1) / n)
        label = f"video {i + 1} of {n}" if n > 1 else "the video"
        sub.progress(0.0, f"Transcribing {label}", force=True)
        src = ingest(sub.sub(0.0, 0.1), src["id"])
        tr = transcribe(sub.sub(0.1, 0.75), src["id"])
        duration = float(src.get("duration_sec") or 0)
        videos.append((src.get("filename") or f"Video {i + 1}", duration, list(tr.get("words") or [])))
        name = "video_light.mp4" if n == 1 else f"video_light_{i + 1}.mp4"
        out = folder / name
        tmp = folder / f"{out.stem}.part.mp4"
        sub.progress(0.76, f"Making the light copy of {label}", force=True)
        ffmpeg.run_ffmpeg(proxy_args(source_file(ctx, src), tmp), duration=duration,
                          on_progress=lambda p, s=sub: s.progress(0.76 + 0.24 * p))
        tmp.replace(out)
        proxies.append(name)
    (folder / "video_transcript.txt").write_text(transcript_text(videos), encoding="utf-8")
    (folder / "gemini_prompt.txt").write_text(prompt_text([(v[0], v[1]) for v in videos], proxies), encoding="utf-8")
    files = ["video_transcript.txt", *proxies, "gemini_prompt.txt"]
    ctx.progress(1.0, "Ready for Gemini", force=True)
    return {"folder": str(folder), "files": files, "keys": [f"{manual_dir(project_id)}/{f}" for f in files]}


# ── building clips from the plan ──────────────────────────────────────────
def snap_segments(segments: Sequence[dict[str, Any]], words: Sequence[dict[str, Any]], duration: float) -> list[tuple[float, float]]:
    """Segments as (start, end) seconds: edges moved out of the middle of words, clamped to the video,
    too-short ones dropped, and a segment that continues the previous one (same place, in order) joined
    to it so there is no needless cut."""
    out: list[tuple[float, float]] = []
    for sg in segments:
        s, e = mt._word_edges(words, float(sg["start"]), float(sg["end"]))
        s, e = max(0.0, s), min(duration, e) if duration > 0 else e
        if e - s < MIN_SEGMENT:
            continue
        if out and abs(s - out[-1][1]) <= 0.05:
            out[-1] = (out[-1][0], e)
        else:
            out.append((round(s, 3), round(e, 3)))
    return out


def clip_edit(pieces: Sequence[dict[str, Any]], words: Sequence[dict[str, Any]], hook: str,
              style_id: str = DEFAULT_STYLE) -> dict[str, Any]:
    """The EditState of a clip from the plan: its segments as pieces, captions on, the hook card for the
    first HOOK_SECONDS (or the whole clip when it is shorter), progress bar on."""
    edit = mt.montage_edit(pieces, words, style_id)
    total = sum(p["srcEnd"] - p["srcStart"] for p in pieces)
    hook = hook.strip()
    edit["captions"]["enabled"] = True
    edit["hook"] = {"enabled": bool(hook), "text": hook, "durationSec": round(min(HOOK_SECONDS, max(0.5, total)), 3)}
    edit["progressBar"]["enabled"] = True
    for i, p in enumerate(pieces):  # keep the worker's own frame choice (montage pool "fit" scenes)
        if p.get("frame"):
            edit["video"][i]["frame"] = p["frame"]
    return edit


def _queue_render(ctx: JobContext, project_id: str, clip_id: str) -> str:
    rid = ctx.db.insert("renders", {"clip_id": clip_id, "status": "queued", "options": {}})
    ctx.db.enqueue("render", {"render_id": rid}, project_id=project_id, dedupe_key=f"render:{rid}", parent_job_id=ctx.job["id"])
    return rid


def manual_clips(ctx: JobContext, project_id: str, plan: Sequence[dict[str, Any]]) -> dict[str, Any]:
    from .reframe import reframe
    from .transcribe import transcribe

    db = ctx.db
    project = db.get("projects", project_id)
    if project is None:
        raise PermanentError("project not found")
    if not plan:
        raise PermanentError("the JSON has no clips")
    plan = list(plan)[:MAX_CLIPS]
    sources = {s["id"]: s for s in inputs_of(db, project_id)}
    words: dict[str, list[dict[str, Any]]] = {}
    for sid in {sg["source"] for c in plan for sg in c.get("segments") or []}:
        if sid not in sources:
            raise PermanentError("a segment points at a video that is not in this project")
        sources[sid] = ingest(ctx.sub(0.0, 0.02), sid)
        words[sid] = list(transcribe(ctx.sub(0.02, 0.05), sid).get("words") or [])

    # every clip's segments, snapped, per source
    clips: list[dict[str, Any]] = []
    for c in plan:
        parts: list[tuple[str, float, float]] = []
        for sg in c.get("segments") or []:
            sid = sg["source"]
            for s, e in snap_segments([sg], words[sid], float(sources[sid].get("duration_sec") or 0)):
                if parts and parts[-1][0] == sid and abs(s - parts[-1][2]) <= 0.05:
                    parts[-1] = (sid, parts[-1][1], e)
                else:
                    parts.append((sid, s, e))
        if parts:
            clips.append({"title": str(c.get("title") or "").strip()[:120], "hook": str(c.get("hook") or "").strip()[:200], "parts": parts})
    if not clips:
        raise PermanentError("none of the clips has a usable segment")

    existing = len(db.many("clips", "select id from clips where project_id = ?", project_id))
    clip_ids: list[str] = []
    render_ids: list[str] = []
    if project.get("kind") == "montage":
        clip_ids, render_ids = _pool_clips(ctx, project_id, clips, sources, words, existing, reframe)
    else:
        for k, c in enumerate(clips):
            sid = c["parts"][0][0]
            pieces = [{"srcStart": s, "srcEnd": e} for _sid, s, e in c["parts"] if _sid == sid]
            start, end = min(p["srcStart"] for p in pieces), max(p["srcEnd"] for p in pieces)
            cid = db.insert("clips", {
                "project_id": project_id, "source_video_id": sid, "start_sec": start, "end_sec": end,
                "title": c["title"] or f"Clip {existing + k + 1}", "hook": c["hook"] or None,
                "reason": f"From the pasted JSON: {len(pieces)} segment{'s' if len(pieces) != 1 else ''}",
                "status": "candidate", "caption_style_id": DEFAULT_STYLE,
                "edit_state": clip_edit(pieces, [w for w in words[sid] if w["e"] > start and w["s"] < end], c["hook"]),
            })
            clip_ids.append(cid)
            sub = ctx.sub(0.1 + 0.85 * k / len(clips), 0.1 + 0.85 * (k + 1) / len(clips))
            sub.progress(0.0, f"Framing clip {k + 1} of {len(clips)}", force=True)
            reframe(sub, cid)
            render_ids.append(_queue_render(ctx, project_id, cid))
    ctx.progress(1.0, f"Made {len(clip_ids)} clips from the JSON", force=True)
    return {"clip_ids": clip_ids, "render_ids": render_ids}


def _pool_clips(ctx: JobContext, project_id: str, clips: list[dict[str, Any]], sources: dict[str, dict[str, Any]],
                words: dict[str, list[dict[str, Any]]], existing: int, reframe: Any) -> tuple[list[str], list[str]]:
    """Montage projects: all segments of all clips cut into one scene pool (like a montage), each clip an
    edit of the pool. Segments used by several clips are cut once."""
    db = ctx.db
    size = mt.canvas_for([(int(s.get("width") or 0), int(s.get("height") or 0)) for s in sources.values() if s.get("width")])
    order = list(sources)
    unique: dict[tuple[str, float, float], str] = {}
    scenes: list[dict[str, Any]] = []
    parts: list[mt.Part] = []
    starts: dict[str, tuple[float, float]] = {}
    t = 0.0
    for c in clips:
        for sid, s, e in c["parts"]:
            key = (sid, s, e)
            if key in unique:
                continue
            src = sources[sid]
            iw, ih = int(src.get("width") or 0), int(src.get("height") or 0)
            fit = bool(iw and ih) and mt.shape_of(iw, ih) != mt.shape_of(*size) and mt.shape_of(*size) != "v"
            d = max(1, round((e - s) * mt.FPS)) / mt.FPS
            scene_id = f"j{len(scenes)}"
            unique[key] = scene_id
            vi = order.index(sid) + 1
            scenes.append({"id": scene_id, "s": round(t, 3), "e": round(t + d, 3), "from": sid,
                           "name": src.get("filename") or f"Video {vi}", "score": 50.0, "srcStart": s, "kind": "speech",
                           **({"fit": True} if fit else {})})
            starts[scene_id] = (round(t, 3), s)
            has_audio = True
            try:
                has_audio = ffmpeg.probe(source_file(ctx, src))["has_audio"]
            except ffmpeg.FfmpegError:
                pass
            parts.append((source_file(ctx, src), s, s + d, has_audio, (iw, ih)))
            t += d
    pool_id = db.insert("source_videos", {"project_id": project_id, "origin": "upload", "role": "pool",
                                          "filename": "Clips from JSON", "status": "importing", "scenes": scenes})
    key = f"sources/{pool_id}/source.mp4"
    out = ctx.settings.storage_path(key)
    tmp = out.with_name("source.part.mp4")
    ctx.progress(0.1, f"Cutting {len(parts)} segments from the original videos", force=True)
    try:
        ffmpeg.run_ffmpeg(mt.pool_args(parts, size, tmp), duration=t, on_progress=lambda p: ctx.progress(0.1 + 0.6 * p))
        tmp.replace(out)
    except Exception:
        db.update("source_videos", pool_id, {"status": "failed", "error": "could not cut the segments"})
        raise
    db.update("source_videos", pool_id, {"storage_key": key, "status": "pending", "framing": "center" if size[1] > size[0] else "speaker"})
    ingest(ctx.sub(0.7, 0.75), pool_id)
    pool_words = mt.pool_words(scenes, words, starts)
    db.insert("transcripts", {"source_video_id": pool_id, "language": None, "words": pool_words,
                              "segments": seg.sentences_to_segments(seg.build_sentences(pool_words)),
                              "speakers": sorted({w["spk"] for w in pool_words if w.get("spk")}) or ["S1"], "model": "manual"})
    pool_end = round(float(db.get("source_videos", pool_id)["duration_sec"] or t), 3)  # type: ignore[index]
    by_id = {sc["id"]: sc for sc in scenes}
    clip_ids: list[str] = []
    render_ids: list[str] = []
    track: Optional[dict[str, Any]] = None
    for k, c in enumerate(clips):
        pieces = []
        for sid, s, e in c["parts"]:
            sc = by_id[unique[(sid, s, e)]]
            pieces.append({"scene": sc["id"], "srcStart": sc["s"], "srcEnd": sc["e"],
                           **({"frame": dict(mt.CENTRE_CROP)} if sc.get("fit") else {})})
        cid = db.insert("clips", {
            "project_id": project_id, "source_video_id": pool_id, "start_sec": 0.0, "end_sec": pool_end,
            "title": c["title"] or f"Clip {existing + k + 1}", "hook": c["hook"] or None,
            "reason": "From the pasted JSON: " + ", ".join(dict.fromkeys(by_id[p["scene"]]["name"] for p in pieces)),
            "status": "candidate", "caption_style_id": DEFAULT_STYLE,
            "edit_state": clip_edit(pieces, pool_words, c["hook"]),
        })
        clip_ids.append(cid)
        if track is None:
            ctx.progress(0.8, "Framing the clips", force=True)
            track = reframe(ctx.sub(0.8, 0.98), cid)
        else:
            db.update("clips", cid, {"crop_track": track})
        render_ids.append(_queue_render(ctx, project_id, cid))
    return clip_ids, render_ids


def handle_manual_export(ctx: JobContext) -> dict[str, Any]:
    pid = ctx.payload.get("project_id")
    if not pid:
        raise PermanentError("payload.project_id is required")
    return manual_export(ctx, pid)


def handle_manual_clips(ctx: JobContext) -> dict[str, Any]:
    pid = ctx.payload.get("project_id")
    if not pid:
        raise PermanentError("payload.project_id is required")
    clips = ctx.payload.get("clips")
    if not isinstance(clips, list):
        raise PermanentError("payload.clips must be a list")
    return manual_clips(ctx, pid, clips)


HANDLERS = {"manual_export": handle_manual_export, "manual_clips": handle_manual_clips}
