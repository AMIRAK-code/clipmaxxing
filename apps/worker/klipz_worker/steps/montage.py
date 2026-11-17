"""Montage: several uploaded videos -> short vertical mixes of their most exciting scenes.

  1. every upload is ingested and transcribed (the same steps a clip project uses), and its motion is
     measured (FFmpeg scene scores at a few frames per second);
  2. find_scenes() scores every moment by loudness/energy against that video's own baseline, motion, and
     how lively what is said is, then grows the best moments into 2-5 s scenes that start and end on
     shot changes or between words, never mid-word (a scene with speech may run to 6 s to finish it);
  3. the best scenes of all uploads (every upload contributes) are cut into ONE vertical, normalised
     "pool" video (1080x1920, 30 fps, 48 kHz): landscape scenes follow the main face, or show the whole
     picture on a blurred copy when there is none; each scene keeps up to 1 s of extra footage on both
     sides so it can be trimmed longer in the editor;
  4. assemble_montages() picks scenes for each montage at random (weighted by score, never two scenes
     of the same upload in a row when there is a choice, spreading scenes over the montages) until the
     montage is as long as asked; each montage becomes an ordinary clip on the pool, so the editor and
     both renderers work unchanged. server/montage.ts has the same assembly (same generator, same
     result for the same seed) for "New mix" / "Make more" in the app.
"""
from __future__ import annotations

import logging
import math
import random
import shutil
import statistics
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence

from .. import ffmpeg
from ..runner import JobCancelled, JobContext, PermanentError
from . import heuristics as H
from . import segment as seg
from .features import AudioProfile
from .ingest import ingest, source_file
from .smart_edit import QuietSnap, snap_for

log = logging.getLogger("klipz.montage")

OUT_W, OUT_H, FPS = 1080, 1920, 30
SAMPLE_RATE = 48000
SAMPLES_PER_FRAME = SAMPLE_RATE // FPS   # 1600: a whole number, so audio and video lengths match exactly
STEP = 0.5                    # scoring grid (seconds)
WINDOW = 3.0                  # each grid point scores the next WINDOW seconds
SCENE_MIN, SCENE_MAX, SCENE_SPEECH_MAX = 2.0, 5.0, 6.0
HANDLE = 1.0                  # extra footage kept on each side of a scene in the pool
MIN_GAP = 3.0                 # scenes of one upload are at least this far apart
CUT_SNAP = 0.6                # a scene edge this close to a shot change moves onto it
MOTION_FPS = 4
SCENES_PER_MONTAGE = 4        # about 4 scenes of 2-5 s fill a 10-20 s montage
POOL_FACTOR = 3               # the pool offers about 3x the scenes the montages need (for "add scene")
POOL_MIN, POOL_MAX = 8, 80
MIN_TRIMMED = 1.0             # a scene trimmed to fit the montage length keeps at least this much
WEIGHTS_SPEECH = {"audio": 0.45, "motion": 0.25, "speech": 0.30}
WEIGHTS_SILENT = {"audio": 0.60, "motion": 0.40}
DEFAULTS = {"count": 5, "minSec": 10.0, "maxSec": 20.0}


# ── scoring ───────────────────────────────────────────────────────────────
@dataclass
class Moment:
    t: float
    score: float
    parts: dict[str, float]


@dataclass
class SceneSpan:
    start: float
    end: float
    score: float
    parts: dict[str, float]
    has_speech: bool = False
    text: str = ""

    @property
    def duration(self) -> float:
        return self.end - self.start


def _pct(vals: Sequence[float], q: float) -> float:
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))]


def motion_curve(path: Path, duration: float) -> list[tuple[float, float]]:
    """(time, FFmpeg scene score) a few times per second over the whole video: how much the picture
    changes. Empty when it cannot be measured."""
    try:
        return ffmpeg._frame_values(
            ["-i", str(path), "-an", "-vf", f"fps={MOTION_FPS},scale=160:-2,select='gte(scene,0)',metadata=print:file=-"],
            "lavfi.scene_score",
        )
    except ffmpeg.FfmpegError as e:
        log.warning("motion could not be measured (%s)", e)
        return []


def _speech_score(text: str) -> float:
    """0..100: how lively / attention-grabbing a few seconds of speech read."""
    if not text.strip():
        return 0.0
    return max(0.0, min(100.0, 100.0 * (0.45 * H.excitement(text) + 0.25 * H.intensity(text)) + 0.30 * H.hook_strength(text)))


def score_moments(duration: float, profile: AudioProfile, motion: Sequence[tuple[float, float]],
                  words: Sequence[dict[str, Any]]) -> list[Moment]:
    """Score of every STEP of the video for the WINDOW seconds that follow it (0..100)."""
    n = int(max(0.0, duration - WINDOW) / STEP) + 1 if duration > 0 else 0
    times = [i * STEP for i in range(n)]
    # motion: mean scene score per window, relative to this video's own busier windows
    raw_motion: list[float] = []

    mot = sorted(motion)
    for t in times:
        vals = [v for (mt, v) in mot if t <= mt < t + WINDOW]
        raw_motion.append(statistics.fmean(vals) if vals else 0.0)

    ref = _pct([v for v in raw_motion if v > 0], 0.9) or 1.0
    out: list[Moment] = []
    for t, mv in zip(times, raw_motion):
        hype = profile.hype(t, t + WINDOW)
        audio = float(hype["score"]) if hype else 50.0
        motion_s = max(0.0, min(100.0, 100.0 * mv / ref))
        ws = [w for w in words if float(w["e"]) > t and float(w["s"]) < t + WINDOW]
        parts = {"audio": round(audio, 1), "motion": round(motion_s, 1)}
        if len(ws) >= 2:
            parts["speech"] = round(_speech_score(" ".join(str(w["w"]) for w in ws)), 1)
            weights = WEIGHTS_SPEECH
        else:
            weights = WEIGHTS_SILENT
        score = sum(parts[k] * wgt for k, wgt in weights.items())
        out.append(Moment(t, round(score, 2), parts))
    return out


def _grow(t: float, duration: float, words: Sequence[dict[str, Any]], sentences: Sequence[seg.Sentence],
          cuts: Sequence[float], snap: Optional[QuietSnap]) -> tuple[float, float, bool, str]:
    """A scene around the moment at `t`: (start, end, has speech, text)."""
    ws = [w for w in words if float(w["e"]) > t and float(w["s"]) < t + WINDOW]
    if ws:
        first, last = ws[0], ws[-1]
        sent_first = next((s for s in sentences if s.s <= float(first["s"]) <= s.e), None)
        if sent_first and sent_first.s < t - 1.5:
            # the first words are the tail of a sentence that began well before ("...here we go."):
            # start with the next sentence instead of on a stray fragment, when one starts in time
            nxt = next((s for s in sentences if float(first["s"]) < s.s < t + WINDOW), None)
            if nxt is not None:
                ws = [w for w in ws if float(w["s"]) >= nxt.s - 1e-6] or ws
                first, last, sent_first = ws[0], ws[-1], nxt
        start = sent_first.s if sent_first and sent_first.s >= t - 1.5 else float(first["s"])
        sent_last = next((s for s in sentences if s.s <= float(last["s"]) <= s.e), None)
        if sent_last and sent_last.e - start <= SCENE_SPEECH_MAX:
            end = sent_last.e
        else:
            ends = [float(w["e"]) for w in words if start < float(w["e"]) <= start + SCENE_MAX]
            end = max(ends) if ends else float(last["e"])
        if end - start < SCENE_MIN:  # too short: run on to the end of a later word, or into the pause
            later = [float(w["e"]) for w in words if start + SCENE_MIN <= float(w["e"]) <= start + SCENE_SPEECH_MAX]
            end = min(later) if later else start + SCENE_MIN
        start, end = max(0.0, start - 0.1), min(duration, end + 0.15)
        if snap is not None:
            start = snap.earlier(start, max(0.0, start - 0.2))
            end = snap.later(end, min(duration, end + 0.25))
        text = " ".join(str(w["w"]) for w in words if float(w["s"]) >= start - 0.05 and float(w["e"]) <= end + 0.05)
        return start, end, True, text.strip()
    start, end = t, min(duration, t + WINDOW)
    # land on shot changes instead of flashing a few frames of the neighbouring shot
    near_start = [c for c in cuts if start < c <= start + CUT_SNAP]
    if near_start:
        start = near_start[-1]
    near_end = [c for c in cuts if end - CUT_SNAP <= c < end]
    if near_end and near_end[0] - start >= SCENE_MIN:
        end = near_end[0]
    if end - start < SCENE_MIN:
        end = min(duration, start + SCENE_MIN)
    return start, end, False, ""


def find_scenes(duration: float, moments: Sequence[Moment], words: Sequence[dict[str, Any]],
                cuts: Sequence[float] = (), snap: Optional[QuietSnap] = None, limit: int = 20) -> list[SceneSpan]:
    """The `limit` best scenes of one video, best first, at least MIN_GAP apart."""
    sentences = seg.build_sentences(list(words)) if words else []
    taken: list[SceneSpan] = []
    for m in sorted(moments, key=lambda x: (-x.score, x.t)):
        if len(taken) >= limit:
            break
        mid = m.t + WINDOW / 2
        if any(s.start - MIN_GAP < mid < s.end + MIN_GAP for s in taken):
            continue
        start, end, speech, text = _grow(m.t, duration, words, sentences, cuts, snap)
        if end - start < SCENE_MIN - 1e-6:
            continue
        cap = SCENE_SPEECH_MAX if speech else SCENE_MAX
        end = min(end, start + cap)
        if any(start < s.end + MIN_GAP and end > s.start - MIN_GAP for s in taken):
            continue
        taken.append(SceneSpan(round(start, 3), round(end, 3), m.score, m.parts, speech, text))
    return taken


def pool_size(count: int) -> int:
    return int(min(POOL_MAX, max(POOL_MIN, count * SCENES_PER_MONTAGE * POOL_FACTOR)))


def choose_pool(per_input: dict[str, list[SceneSpan]], size: int) -> list[tuple[str, SceneSpan]]:
    """The pool's scenes: every upload gets an equal share of its best ones first, the rest of the room
    goes to the best remaining scenes of any upload. Returned in the order they go into the pool:
    upload by upload, in time order (so the pool video reads like a highlight reel)."""
    ids = list(per_input)
    if not ids:
        return []
    share = max(1, size // len(ids))
    picked: list[tuple[str, SceneSpan]] = []
    rest: list[tuple[str, SceneSpan]] = []
    for sid in ids:
        best = per_input[sid]
        picked += [(sid, s) for s in best[:share]]
        rest += [(sid, s) for s in best[share:]]
    rest.sort(key=lambda x: -x[1].score)
    picked += rest[: max(0, size - len(picked))]
    order = {sid: i for i, sid in enumerate(ids)}
    return sorted(picked, key=lambda x: (order[x[0]], x[1].start))


# ── framing and the pool video ────────────────────────────────────────────
def frame_mode(path: Path, src_w: int, src_h: int, start: float, end: float, detector: Any) -> tuple[str, float]:
    """("fill" | "crop" | "fit", face centre x 0..1): vertical uploads fill the screen; wider ones follow
    the main face, or show the whole frame on a blurred copy when no face is seen."""
    if src_w <= 0 or src_h <= 0:
        return "fit", 0.5
    if src_h >= src_w * 1.2:
        return "fill", 0.5
    if detector is None:
        return "fit", 0.5
    from .reframe import iter_frames

    xs: list[float] = []
    samples = 0
    fps = max(0.4, 5.0 / max(0.5, end - start))
    for _t, frame in iter_frames(path, start, end, src_w, src_h, fps=fps):
        samples += 1
        faces = detector.detect(frame)
        if faces:
            xs.append(max(faces, key=lambda f: f.area).cx)
    if xs and len(xs) >= max(1, math.ceil(samples * 0.4)):
        return "crop", float(statistics.median(xs))
    return "fit", 0.5


def _video_chain(mode: str, cx: float, src_w: int, src_h: int, color: str) -> str:
    tail = f"setsar=1,fps={FPS},tpad=stop_mode=clone:stop_duration=1"
    if mode == "crop":
        h = src_h // 2 * 2
        cw = min(src_w // 2 * 2, int(h * 9 / 16) // 2 * 2)
        x = int(round(min(max(cx * src_w - cw / 2, 0), src_w - cw)))
        return f"[0:v:0]{color},crop={cw}:{h}:{x}:0,scale={OUT_W}:{OUT_H}:flags=lanczos,{tail}[v]"
    if mode == "fill":
        return (f"[0:v:0]{color},scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={OUT_W}:{OUT_H},{tail}[v]")
    # fit: the whole frame over a blurred, darkened copy of itself (blurred small, then scaled up)
    return (f"[0:v:0]{color},split=2[bg][fg];"
            f"[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=8:2,"
            f"scale={OUT_W}:{OUT_H},eq=brightness=-0.12[b];"
            f"[fg]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease:flags=lanczos[f];"
            f"[b][f]overlay=(W-w)/2:(H-h)/2,{tail}[v]")


def render_pool_scene(src: Path, start: float, frames: int, out: Path, *, mode: str, cx: float, src_w: int, src_h: int,
                      has_audio: bool, color: str = "format=yuv420p") -> None:
    """One scene of the pool: exactly `frames` frames at 30 fps and frames x 1600 audio samples, so the
    scenes join without drift. Written as MOV (H.264 + PCM) so the pool can join them without re-encoding
    the picture."""
    dur = frames / FPS
    inputs = ["-ss", f"{max(0.0, start):.3f}", "-t", f"{dur + 0.5:.3f}", "-i", str(src)]
    if has_audio:
        audio = f"[0:a:0]aresample={SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=stereo,apad,atrim=end_sample={frames * SAMPLES_PER_FRAME}[a]"
    else:
        inputs += ["-f", "lavfi", "-t", f"{dur + 0.5:.3f}", "-i", f"anullsrc=r={SAMPLE_RATE}:cl=stereo"]
        audio = f"[1:a]aformat=sample_fmts=s16:channel_layouts=stereo,atrim=end_sample={frames * SAMPLES_PER_FRAME}[a]"
    graph = _video_chain(mode, cx, src_w, src_h, color) + ";" + audio
    ffmpeg.run_ffmpeg([
        *inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-frames:v", str(frames),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-g", "15", "-keyint_min", "15", "-sc_threshold", "0",
        "-pix_fmt", "yuv420p", "-profile:v", "high", "-video_track_timescale", "15360",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "pcm_s16le", str(out),
    ])


def join_pool(parts: Sequence[Path], out: Path, work: Path) -> None:
    """Join the scene files: the picture is copied (all encoded alike), the sound becomes AAC once."""
    listing = work / "pool.txt"
    listing.write_text("".join("file '" + str(p).replace("'", "'\\''") + "'\n" for p in parts), encoding="utf-8")
    ffmpeg.run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(listing), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
                       "-c:a", "aac", "-b:a", "192k", "-ar", str(SAMPLE_RATE), "-movflags", "+faststart", str(out)])


# ── assembly (same as server/montage.ts) ──────────────────────────────────
_M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _M32


class Rng:
    """mulberry32, the generator server/montage.ts uses: one seed gives the same mix in both."""

    def __init__(self, seed: int):
        self.a = int(seed) & _M32

    def next(self) -> float:
        self.a = (self.a + 0x6D2B79F5) & _M32
        t = self.a
        t = _imul(t ^ (t >> 15), t | 1)
        t = ((t + _imul(t ^ (t >> 7), t | 61)) & _M32) ^ t
        return ((t ^ (t >> 14)) & _M32) / 4294967296.0


def _r3(x: float) -> float:
    """Math.round(x * 1000) / 1000, as the TypeScript side rounds."""
    return math.floor(x * 1000 + 0.5) / 1000


def assemble_montages(scenes: Sequence[dict[str, Any]], count: int, min_sec: float, max_sec: float, seed: int,
                      usage: Optional[dict[str, int]] = None) -> list[list[dict[str, Any]]]:
    """Pieces for `count` montages. `scenes`: [{id, input, start, end, score}] in pool time, in pool order.
    Each montage: [{sceneId, srcStart, srcEnd}]. `usage` (scene id -> times used) spreads scenes over the
    montages already made."""
    rng = Rng(seed)
    use = dict(usage or {})
    out: list[list[dict[str, Any]]] = []
    for _ in range(max(0, count)):
        target = min_sec + rng.next() * (max_sec - min_sec)
        picks: list[dict[str, Any]] = []
        chosen: set[str] = set()
        total = 0.0
        last: Optional[str] = None
        while total < target - 0.05:
            left = [s for s in scenes if s["id"] not in chosen]
            if not left:
                break
            room = max_sec - total
            fits = [s for s in left if float(s["end"]) - float(s["start"]) <= room + 1e-6]
            if not fits and room < MIN_TRIMMED:
                break  # no scene fits and a trimmed one would be a flash: the montage ends here
            pool = fits or left
            varied = [s for s in pool if s["input"] != last] or pool
            least = min(use.get(s["id"], 0) for s in varied)
            cands = [s for s in varied if use.get(s["id"], 0) == least]
            weights = [max(1.0, float(s.get("score") or 0)) for s in cands]
            r = rng.next() * sum(weights)
            pick = cands[-1]
            for s, w in zip(cands, weights):
                r -= w
                if r < 0:
                    pick = s
                    break
            start, end = float(pick["start"]), float(pick["end"])
            if end - start > room:  # nothing fits the room left: end this scene early
                end = start + room
            picks.append({"sceneId": pick["id"], "srcStart": _r3(start), "srcEnd": _r3(end)})
            chosen.add(pick["id"])
            use[pick["id"]] = use.get(pick["id"], 0) + 1
            total += end - start
            last = pick["input"]
        out.append(picks)
    return out


def montage_edit(pieces: Sequence[dict[str, Any]], words: Sequence[dict[str, Any]], hook: str = "") -> dict[str, Any]:
    """EditState (packages/shared/src/types.ts) of a montage: captions off (but ready to switch on), the
    hook card off with a suggested line, no zooms or progress bar."""
    video = [{"id": f"v{i}_{int(round(float(p['srcStart']) * 1000))}", "srcStart": p["srcStart"], "srcEnd": p["srcEnd"]}
             for i, p in enumerate(pieces)]
    caption_words: list[dict[str, Any]] = []
    for i, w in enumerate(words):
        mid = (float(w["s"]) + float(w["e"])) / 2
        if any(float(p["srcStart"]) <= mid < float(p["srcEnd"]) for p in pieces):
            caption_words.append({"id": f"w{i}_{int(round(float(w['s']) * 1000))}", "w": str(w["w"]).strip(),
                                  "s": float(w["s"]), "e": float(w["e"])})
    return {
        "version": 1,
        "video": video,
        "captions": {"enabled": False, "styleId": "bold-outline", "overrides": {}, "words": caption_words},
        "broll": [],
        "audio": [],
        "texts": [],
        "zooms": [],
        "look": "none",
        "hook": {"enabled": False, "text": hook, "durationSec": 2.5},
        "progressBar": {"enabled": False, "color": "#FFE600", "position": "bottom", "height": 10},
        "volume": 1,
        "duckLevel": 0.25,
        "safeZone": "tiktok",
    }


def full_frame_track(duration: float) -> dict[str, Any]:
    """Crop track of the pool: it is already 9:16, so the whole frame (no reframe per montage)."""
    return {"version": 1, "srcW": OUT_W, "srcH": OUT_H,
            "segments": [{"start": 0.0, "end": round(duration, 3), "layout": "crop", "keys": [{"t": 0.0, "cx": 0.5, "cy": 0.5}]}]}


def settings_of(project: dict[str, Any]) -> dict[str, Any]:
    s = {**DEFAULTS, **(project.get("settings") or {})}
    count = int(min(20, max(1, int(s["count"]))))
    lo, hi = float(s["minSec"]), float(s["maxSec"])
    lo, hi = max(5.0, min(lo, hi)), min(60.0, max(lo, hi))
    return {"count": count, "minSec": lo, "maxSec": max(lo, hi), "seed": s.get("seed")}


# ── the job ───────────────────────────────────────────────────────────────
@dataclass
class _Input:
    source: dict[str, Any]
    path: Path
    words: list[dict[str, Any]] = field(default_factory=list)
    scenes: list[SceneSpan] = field(default_factory=list)


def _scene_rows(db: Any, project_id: str) -> list[dict[str, Any]]:
    return db.many("montage_scenes", "select * from montage_scenes where project_id = ? order by idx", project_id)


def _transcribe_words(ctx: JobContext, source_id: str) -> list[dict[str, Any]]:
    """The upload's words; none (scenes picked by sound and motion only) when it cannot be transcribed."""
    from .transcribe import transcribe

    try:
        return list(transcribe(ctx, source_id).get("words") or [])
    except JobCancelled:
        raise
    except Exception as e:  # noqa: BLE001 - a silent or untranscribable upload still has scenes
        log.warning("montage: no transcript for %s (%s); scenes from sound and motion only", source_id, e)
        return []


def build_pool(ctx: JobContext, project: dict[str, Any], detector: Any = None) -> str:
    """Analyse the uploads and write the pool video + its scenes. Returns the pool's source id."""
    db = ctx.db
    inputs_rows = db.many("source_videos",
                          "select * from source_videos where project_id = ? and role = 'input' and status != 'deleted' order by created_at",
                          project["id"])
    if not inputs_rows:
        raise PermanentError("this montage has no videos yet")
    settings = settings_of(project)
    n = len(inputs_rows)
    inputs: list[_Input] = []
    for i, row in enumerate(inputs_rows):
        sub = ctx.sub(0.55 * i / n, 0.55 * (i + 1) / n)
        sub.progress(0.0, f"Importing video {i + 1}/{n}", force=True)
        source = ingest(sub.sub(0.0, 0.3), row["id"])
        sub.progress(0.3, f"Transcribing video {i + 1}/{n}", force=True)
        words = _transcribe_words(sub.sub(0.3, 0.85), row["id"])
        sub.progress(0.85, f"Measuring motion in video {i + 1}/{n}", force=True)
        path = source_file(ctx, source)
        motion = motion_curve(path, float(source.get("duration_sec") or 0))
        duration = float(source.get("duration_sec") or 0)
        audio_path = ctx.settings.storage_path(source["audio_key"]) if source.get("audio_key") else None
        moments = score_moments(duration, AudioProfile(source.get("energy")), motion, words)
        snap = snap_for(audio_path, 0.0, duration) if duration <= 3 * 3600 else None
        limit = pool_size(settings["count"])  # never more than the whole pool from one upload
        scenes = find_scenes(duration, moments, words, source.get("scene_cuts") or [], snap, limit=limit)
        inputs.append(_Input(source, path, words, scenes))
    ctx.progress(0.56, "Finding exciting moments", force=True)
    chosen = choose_pool({inp.source["id"]: inp.scenes for inp in inputs}, pool_size(settings["count"]))
    if not chosen:
        raise PermanentError("no usable scenes found in these videos")
    by_id = {inp.source["id"]: inp for inp in inputs}

    if detector is None:
        from ..reframe.detect import default_detector

        detector = default_detector(ctx.settings.data_dir)
    from ..fastrender import engine as fast_engine
    from ..fastrender.graph import color_filters

    pool_id = db.insert("source_videos", {"project_id": project["id"], "origin": "upload", "role": "pool", "status": "importing",
                                          "filename": "montage scenes", "framing": "center"})
    work = ctx.settings.data_dir / "tmp" / f"montage-{pool_id}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        parts: list[Path] = []
        rows: list[dict[str, Any]] = []
        pool_words: list[dict[str, Any]] = []
        offset_frames = 0
        colors: dict[str, str] = {}
        for k, (sid, sc) in enumerate(chosen):
            ctx.progress(0.6 + 0.32 * k / len(chosen), f"Building scenes {k + 1}/{len(chosen)}")
            inp = by_id[sid]
            src = inp.source
            dur_src = float(src.get("duration_sec") or 0)
            f0 = max(0.0, sc.start - HANDLE)
            f1 = min(dur_src, sc.end + HANDLE) if dur_src > 0 else sc.end + HANDLE
            frames = max(1, int(round((f1 - f0) * FPS)))
            w, h = int(src.get("width") or 0), int(src.get("height") or 0)
            mode, cx = frame_mode(inp.path, w, h, sc.start, sc.end, detector)
            if sid not in colors:
                try:
                    ff, fp = ffmpeg.binaries()
                    matrix, full_range = fast_engine.source_color(fp, inp.path)
                    colors[sid] = color_filters(matrix, full_range)
                except Exception:  # noqa: BLE001 - HDR or unprobeable: plain conversion
                    colors[sid] = "format=yuv420p"
            out = work / f"scene_{k:03d}.mov"
            has_audio = bool(src.get("audio_key"))
            try:
                probe = ffmpeg.probe(inp.path)
                has_audio = bool(probe.get("audio_codec"))
            except ffmpeg.FfmpegError:
                pass
            render_pool_scene(inp.path, f0, frames, out, mode=mode, cx=cx, src_w=w, src_h=h, has_audio=has_audio, color=colors[sid])
            parts.append(out)
            off = offset_frames / FPS
            pool_start = off + (sc.start - f0)
            pool_end = min(off + frames / FPS, pool_start + sc.duration)
            for wd in inp.words:
                mid = (float(wd["s"]) + float(wd["e"])) / 2
                if f0 <= mid < f0 + frames / FPS:
                    pool_words.append({**wd, "s": round(off + max(0.0, float(wd["s"]) - f0), 3),
                                       "e": round(off + min(frames / FPS, float(wd["e"]) - f0), 3)})
            rows.append({
                "project_id": project["id"], "input_source_id": sid, "pool_source_id": pool_id, "idx": k,
                "src_start": sc.start, "src_end": sc.end,
                "pool_start": round(pool_start, 3), "pool_end": round(pool_end, 3),
                "pool_min": round(off, 3), "pool_max": round(off + frames / FPS, 3),
                "score": round(sc.score, 2), "breakdown": sc.parts, "text": sc.text or None,
                "has_speech": 1 if sc.has_speech else 0, "input_name": src.get("filename"),
            })
            offset_frames += frames

        ctx.progress(0.93, "Joining the scenes", force=True)
        key = f"sources/{pool_id}/source.mp4"
        dest = ctx.settings.storage_path(key)
        tmp = dest.with_name("source.part.mp4")
        join_pool(parts, tmp, work)
        tmp.replace(dest)
        pool_dur = offset_frames / FPS
        for row in rows:
            mid = (row["pool_start"] + row["pool_end"]) / 2
            thumb_key = f"sources/{pool_id}/scenes/{row['idx']:03d}.jpg"
            try:
                ffmpeg.extract_frame(dest, mid, ctx.settings.storage_path(thumb_key), width=270)
                row["thumb_key"] = thumb_key
            except ffmpeg.FfmpegError as e:
                log.warning("scene thumbnail failed: %s", e)
        try:
            ffmpeg.extract_frame(dest, rows[0]["pool_start"] + 0.5, ctx.settings.storage_path(f"sources/{pool_id}/thumb.jpg"))
        except ffmpeg.FfmpegError:
            pass

        db.conn.execute("BEGIN IMMEDIATE")
        try:
            db.update("source_videos", pool_id, {
                "storage_key": key, "duration_sec": round(pool_dur, 3), "width": OUT_W, "height": OUT_H, "fps": FPS,
                "size_bytes": dest.stat().st_size, "status": "ready",
                "scene_cuts": [r["pool_min"] for r in rows[1:]],
            })
            db.insert("transcripts", {"source_video_id": pool_id, "words": pool_words, "segments": [], "speakers": [],
                                      "model": "montage"})
            for row in rows:
                db.insert("montage_scenes", row)
            db.conn.execute("COMMIT")
        except Exception:
            db.conn.execute("ROLLBACK")
            raise
        return pool_id
    except BaseException:
        db.conn.execute("delete from source_videos where id = ? and status != 'ready'", (pool_id,))
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)


def create_montages(ctx: JobContext, project: dict[str, Any], count: int, seed: Optional[int] = None) -> list[str]:
    """`count` new montage clips from the project's pool, each with a queued render. Returns clip ids."""
    db = ctx.db
    scenes = _scene_rows(db, project["id"])
    if not scenes:
        raise PermanentError("this montage has no scenes yet")
    pool_id = scenes[0]["pool_source_id"]
    pool = db.get("source_videos", pool_id) or {}
    pool_dur = float(pool.get("duration_sec") or 0)
    tr = db.one("transcripts", "select * from transcripts where source_video_id = ?", pool_id) or {}
    words = tr.get("words") or []
    settings = settings_of(project)
    if seed is None:
        seed = int(settings.get("seed") or random.randrange(1, 2**31 - 1))
    usage: dict[str, int] = {}
    existing = db.many("clips", "select * from clips where project_id = ?", project["id"])
    for c in existing:
        for p in ((c.get("edit_state") or {}).get("video") or []):
            for s in scenes:
                if s["pool_start"] - 0.01 <= float(p["srcStart"]) < s["pool_max"]:
                    usage[s["id"]] = usage.get(s["id"], 0) + 1
    plan = assemble_montages(
        [{"id": s["id"], "input": s["input_source_id"] or "", "start": s["pool_start"], "end": s["pool_end"], "score": s["score"]}
         for s in scenes],
        count, settings["minSec"], settings["maxSec"], seed, usage,
    )
    speech = sorted((s for s in scenes if s["has_speech"] and s.get("text")), key=lambda s: -float(s["score"]))
    by_id = {s["id"]: s for s in scenes}
    ids: list[str] = []
    for k, pieces in enumerate(plan):
        if not pieces:
            continue
        used = [by_id[p["sceneId"]] for p in pieces]
        hook_src = next((s for s in used if s["has_speech"] and s.get("text")), speech[0] if speech else None)
        hook = H.punchy(hook_src["text"]) if hook_src else ""
        n = len(existing) + len(ids) + 1
        clip_id = db.insert("clips", {
            "project_id": project["id"], "source_video_id": pool_id, "start_sec": 0.0, "end_sec": max(0.1, pool_dur),
            "score": round(statistics.fmean(float(s["score"]) for s in used), 2),
            "score_breakdown": {"montage": True, "scenes": [p["sceneId"] for p in pieces], "seed": seed + k},
            "title": f"Montage {n}", "hook": hook or None, "status": "kept", "caption_style_id": "bold-outline",
            "crop_track": full_frame_track(pool_dur), "edit_state": montage_edit(pieces, words, hook),
        })
        rid = db.insert("renders", {"clip_id": clip_id, "status": "queued", "options": {}})
        db.enqueue("render", {"render_id": rid}, project_id=project["id"], dedupe_key=f"render:{rid}", parent_job_id=ctx.job["id"])
        ids.append(clip_id)
    db.update("projects", project["id"], {"settings": {**(project.get("settings") or {}), "seed": seed}})
    return ids


def montage(ctx: JobContext, project_id: str, detector: Any = None) -> dict[str, Any]:
    db = ctx.db
    project = db.get("projects", project_id)
    if project is None:
        raise PermanentError("montage project not found")
    if (project.get("kind") or "clips") != "montage":
        raise PermanentError("not a montage project")
    scenes = _scene_rows(db, project_id)
    pool_id = scenes[0]["pool_source_id"] if scenes else None
    if pool_id is None:
        pool_id = build_pool(ctx, project, detector)
    existing = db.many("clips", "select id from clips where project_id = ?", project_id)
    if existing:
        ctx.progress(1.0, "Montages ready", force=True)
        return {"pool_source_id": pool_id, "clip_ids": [c["id"] for c in existing], "created": 0}
    ctx.progress(0.96, "Making montages", force=True)
    project = db.get("projects", project_id) or project
    ids = create_montages(ctx, project, settings_of(project)["count"])
    ctx.progress(1.0, f"Made {len(ids)} montages", force=True)
    return {"pool_source_id": pool_id, "clip_ids": ids, "created": len(ids),
            "scenes": len(_scene_rows(db, project_id))}


def handle_montage(ctx: JobContext) -> dict[str, Any]:
    pid = ctx.payload.get("project_id")
    if not pid:
        raise PermanentError("payload.project_id required")
    return montage(ctx, str(pid))


HANDLERS = {"montage": handle_montage}
