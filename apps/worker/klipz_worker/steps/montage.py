"""Montage: short videos mixed from the exciting moments of several videos.

A montage project holds the videos the person uploaded (source role "input"). The montage job:

  1. imports and transcribes every input,
  2. finds its exciting scenes (find_scenes): short stretches where something is said with energy, the
     sound bursts or the picture changes fast, each 1.2 to 4 s long and cut on word edges / shot changes,
  3. joins all scenes, normalised to one frame size, into a single "scene pool" video (source role
     "pool") with the scene list and the remapped transcript, so it behaves like any other source,
  4. makes `count` montages (compose): random mixes of scenes from different videos, `minSec` to `maxSec`
     long, each an ordinary clip of the pool whose edit lists the scenes as pieces in random order. No
     captions (they can be switched on in the editor: all the pool's words are in the edit), no hook.
  5. frames and renders them like AutoClip does.

"Make more" runs the job again: the pool is reused while the inputs are the same, new montages are added.
"""
from __future__ import annotations

import logging
import math
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence

from .. import ffmpeg
from ..runner import JobContext, PermanentError
from . import heuristics as H
from . import segment as seg
from .features import AudioProfile
from .ingest import ingest, source_file

log = logging.getLogger("klipz.montage")

SCENE_MIN = 1.2          # shortest scene
SCENE_MAX = 4.0          # longest scene
SCENE_WINDOW = 2.5       # length of the sliding windows that find action without words
PHRASE_PAUSE = 0.35      # a pause this long separates two phrases (scenes with speech)
WORD_PAD_BEFORE = 0.12
WORD_PAD_AFTER = 0.22
SNAP_TO_CUT = 0.6        # a window start moves to a shot change this close
MIN_SCENE_SCORE = 35.0   # scenes below this are only used when a video has nothing better
MAX_SCENES_PER_VIDEO = 12
MAX_POOL_SCENES = 80
DEFAULT_COUNT = 3
DEFAULT_MIN_SEC = 10.0
DEFAULT_MAX_SEC = 20.0
FPS = 30


@dataclass
class Scene:
    s: float
    e: float
    score: float
    kind: str = "speech"     # speech | action
    text: str = ""

    @property
    def duration(self) -> float:
        return self.e - self.s


# ── 2. scenes of one video ────────────────────────────────────────────────
def _word_edges(words: Sequence[dict[str, Any]], s: float, e: float) -> tuple[float, float]:
    """Move [s, e] out of the middle of words: a scene never starts or ends inside one. A start inside a
    word moves to just before it, an end inside a word to just after it; the air added never reaches into
    the neighbouring word."""
    spans = sorted((float(w["s"]), float(w["e"])) for w in words)
    for ws, we in spans:
        if ws < s < we:
            prev_end = max((b for a, b in spans if b <= ws), default=-1e9)
            s = max(ws - WORD_PAD_BEFORE, (prev_end + ws) / 2)
        if ws < e < we:
            next_start = min((a for a, b in spans if a >= we), default=1e9)
            e = min(we + WORD_PAD_AFTER, (we + next_start) / 2)
    return s, e


def _text_score(text: str) -> float:
    if not H.tokens(text):
        return 0.0
    return min(100.0, 100.0 * (0.5 * H.excitement(text) + 0.3 * H.intensity(text)) + 0.3 * H.hook_strength(text))


def _cuts_inside(cuts: Sequence[float], s: float, e: float) -> int:
    return sum(1 for c in cuts if s < c < e)


def _audio(profile: AudioProfile, s: float, e: float) -> Optional[float]:
    h = profile.hype(s, e)
    return None if h is None else float(h["score"])


def find_scenes(words: Sequence[dict[str, Any]], energy: Optional[dict[str, Any]], cuts: Sequence[float],
                duration: float, limit: int = MAX_SCENES_PER_VIDEO) -> list[Scene]:
    """The best non-overlapping moments of one video, best first.

    Scenes with speech are phrases (split on short pauses, at most SCENE_MAX long) scored on how lively
    the words read and how loud / bright the sound gets against the video's own baseline. Scenes without
    speech are SCENE_WINDOW windows scored on sound bursts and shot changes; they start on a shot change
    when there is one close by and never cut a word in half."""
    profile = AudioProfile(energy)
    cuts = sorted(float(c) for c in cuts or [])
    words = [w for w in words if str(w.get("w", "")).strip()]
    found: list[Scene] = []

    for ph in seg.build_sentences(list(words), pause=PHRASE_PAUSE, max_len=SCENE_MAX):
        s, e = ph.s - WORD_PAD_BEFORE, ph.e + WORD_PAD_AFTER
        if e - s < SCENE_MIN:
            grow = (SCENE_MIN - (e - s)) / 2
            s, e = _word_edges(words, s - grow, e + grow)
        s, e = max(0.0, s), min(duration, e)
        if e - s < SCENE_MIN * 0.8:
            continue
        audio = _audio(profile, s, e)
        text = _text_score(ph.text)
        score = text if audio is None else 0.55 * text + 0.45 * audio
        score += 4.0 * min(2, _cuts_inside(cuts, s, e))
        found.append(Scene(round(s, 3), round(e, 3), round(score, 2), "speech", ph.text))

    step = SCENE_WINDOW / 2
    t = 0.0
    while t + SCENE_MIN <= duration:
        s = t
        near = [c for c in cuts if abs(c - t) <= SNAP_TO_CUT]
        if near:
            s = min(near, key=lambda c: abs(c - t))
        e = min(duration, s + SCENE_WINDOW)
        s, e = _word_edges(words, s, e)
        s, e = max(0.0, s), min(duration, e)
        t += step
        if not (SCENE_MIN <= e - s <= SCENE_MAX):
            continue
        audio = _audio(profile, s, e)
        n_cuts = _cuts_inside(cuts, s, e)
        score = (audio if audio is not None else 40.0) * 0.8 + min(30.0, 12.0 * n_cuts)
        found.append(Scene(round(s, 3), round(e, 3), round(score, 2), "action"))

    if not found and duration >= SCENE_MIN:
        # no sound data and no words: evenly spread windows so the video still takes part
        n = max(1, min(limit, int(duration // (SCENE_WINDOW * 2))))
        for i in range(n):
            s = (i + 0.5) * duration / n - SCENE_WINDOW / 2
            s = max(0.0, min(duration - SCENE_WINDOW, s))
            found.append(Scene(round(s, 3), round(min(duration, s + SCENE_WINDOW), 3), 30.0, "action"))

    chosen: list[Scene] = []
    for sc in sorted(found, key=lambda x: (-x.score, x.s)):
        if len(chosen) >= limit:
            break
        if any(sc.s < c.e + 0.3 and c.s < sc.e + 0.3 for c in chosen):
            continue
        chosen.append(sc)
    good = [c for c in chosen if c.score >= MIN_SCENE_SCORE]
    return good if len(good) >= min(3, len(chosen)) else chosen


# ── 4. montages ───────────────────────────────────────────────────────────
def compose(scenes: Sequence[dict[str, Any]], count: int, min_sec: float, max_sec: float,
            seed: Optional[int] = None, avoid: Sequence[Sequence[str]] = ()) -> list[list[dict[str, Any]]]:
    """`count` montages, each a list of pieces {scene, srcStart, srcEnd} in play order.

    Scenes are pool scenes {id, s, e, from, score}. Every montage aims for a random length between
    min_sec and max_sec, draws better and less used scenes first, mixes the videos (never two scenes of
    the same video in a row while another one is available) and is shuffled. The last scene is shortened
    rather than going over max_sec. `avoid` lists scene-id sets already made; the same set is not made twice."""
    if not scenes:
        return []
    rng = random.Random(seed)
    used: dict[str, int] = {str(sc["id"]): 0 for sc in scenes}
    seen = {frozenset(a) for a in avoid}
    out: list[list[dict[str, Any]]] = []
    for _ in range(max(0, count)):
        best: Optional[list[dict[str, Any]]] = None
        for _attempt in range(12):
            pick = _pick(scenes, used, rng, rng.uniform(min_sec, max_sec), max_sec)
            if not pick:
                break
            key = frozenset(p["scene"] for p in pick)
            if key not in seen or best is None:
                best = pick
            if key not in seen:
                break
        if not best:
            break
        seen.add(frozenset(p["scene"] for p in best))
        for p in best:
            used[p["scene"]] += 1
        out.append(_mix(best, scenes, rng))
    return out


def _pick(scenes: Sequence[dict[str, Any]], used: dict[str, int], rng: random.Random, target: float,
          max_sec: float) -> list[dict[str, Any]]:
    by_id = {str(sc["id"]): sc for sc in scenes}
    pool = list(by_id)
    total = 0.0
    pick: list[dict[str, Any]] = []
    per_video: dict[Any, int] = {}
    while pool and total < target - 0.4:
        def weight(i: str) -> float:
            sc = by_id[i]
            w = max(5.0, float(sc.get("score") or 40.0)) / (1.0 + 1.5 * used[i])
            # spread the montage over the videos: each scene already taken from a video halves its chances,
            # and no video gets more scenes than all the others plus one (so they can alternate)
            mine = per_video.get(sc.get("from"), 0)
            if mine > len(pick) - mine and any(by_id[j].get("from") != sc.get("from") for j in pool):
                return 0.0
            return w / (2.0 ** mine)
        weights = [weight(i) for i in pool]
        if not any(weights):
            weights = [1.0] * len(pool)
        i = rng.choices(pool, weights=weights, k=1)[0]
        pool.remove(i)
        sc = by_id[i]
        s, e = float(sc["s"]), float(sc["e"])
        room = max_sec - total
        if e - s > room:
            if room < SCENE_MIN:
                continue  # does not fit any more; a shorter scene might
            e = s + room
        pick.append({"scene": i, "srcStart": round(s, 3), "srcEnd": round(e, 3)})
        per_video[sc.get("from")] = per_video.get(sc.get("from"), 0) + 1
        total += e - s
    return pick


def _mix(pick: list[dict[str, Any]], scenes: Sequence[dict[str, Any]], rng: random.Random) -> list[dict[str, Any]]:
    """Random order with no two scenes of the same video next to each other when that can be avoided:
    each step takes a scene of the video with the most scenes left (ties at random), other than the
    previous one's."""
    src = {str(sc["id"]): sc.get("from") for sc in scenes}
    groups: dict[Any, list[dict[str, Any]]] = {}
    for p in pick:
        groups.setdefault(src.get(p["scene"]), []).append(p)
    for g in groups.values():
        rng.shuffle(g)
    out: list[dict[str, Any]] = []
    prev = object()
    while any(groups.values()):
        options = [k for k, g in groups.items() if g and k != prev] or [k for k, g in groups.items() if g]
        most = max(len(groups[k]) for k in options)
        k = rng.choice([k for k in options if len(groups[k]) == most])
        out.append(groups[k].pop())
        prev = k
    return out


# The framing of a scene that sits whole in the middle of the pool frame: the middle, filling the screen.
CENTRE_CROP = {"layout": "crop", "cx": 0.5, "cy": 0.5, "zoom": 1}


def montage_edit(pieces: Sequence[dict[str, Any]], words: Sequence[dict[str, Any]], style_id: str = "bold-outline",
                 scenes: Sequence[dict[str, Any]] = ()) -> dict[str, Any]:
    """The EditState of one montage: its scenes as pieces, captions off (all the pool's words are in it, so
    turning them on or adding a scene in the editor just works), no hook card, the sound on. A scene of
    another shape than the pool ("fit") gets a centred crop of its own instead of the face tracking."""
    fit = {str(sc["id"]) for sc in scenes if sc.get("fit")}
    video = []
    for i, p in enumerate(pieces):
        piece: dict[str, Any] = {"id": f"m{i}_{int(round(p['srcStart'] * 1000))}", "srcStart": p["srcStart"], "srcEnd": p["srcEnd"]}
        if p.get("scene") in fit:
            piece["frame"] = dict(CENTRE_CROP)
        video.append(piece)
    caption_words = []
    for i, w in enumerate(words):
        if not str(w.get("w", "")).strip():
            continue
        cw: dict[str, Any] = {"id": f"w{i}_{int(round(float(w['s']) * 1000))}", "w": str(w["w"]).strip(),
                              "s": float(w["s"]), "e": float(w["e"])}
        if w.get("spk"):
            cw["spk"] = w["spk"]
        caption_words.append(cw)
    return {
        "version": 1,
        # not an automatic Smart Edit: re-analysis and trims must never replace a montage
        "auto": False,
        "video": video,
        "captions": {"enabled": False, "styleId": style_id, "overrides": {}, "words": caption_words},
        "broll": [],
        "audio": [],
        "texts": [],
        "zooms": [],
        "look": "none",
        "hook": {"enabled": False, "text": "", "durationSec": 2.0},
        "progressBar": {"enabled": False, "color": "#FFE600", "position": "bottom", "height": 10},
        "volume": 1,
        "duckLevel": 0.25,
        "safeZone": "tiktok",
    }


# ── 3. the scene pool ─────────────────────────────────────────────────────
def canvas_for(sizes: Sequence[tuple[int, int]]) -> tuple[int, int]:
    """One frame size for every scene: the shape most inputs have (vertical, landscape or square), at most
    1080 on the short side, never larger than the biggest input."""
    if not sizes:
        return 1920, 1080
    shapes = {"v": 0, "h": 0, "s": 0}
    for w, h in sizes:
        shapes["v" if h > w * 1.1 else "h" if w > h * 1.1 else "s"] += 1
    shape = max(shapes, key=lambda k: (shapes[k], k == "h"))
    short = min(1080, max(min(w, h) for w, h in sizes))
    short -= short % 2
    long = int(round(short * 16 / 9)) // 2 * 2
    return {"v": (short, long), "h": (long, short), "s": (short, short)}[shape]


def shape_of(w: int, h: int) -> str:
    return "v" if h > w * 1.1 else "h" if w > h * 1.1 else "s"


Part = tuple[Path, float, float, bool, tuple[int, int]]  # file, start, end, has_audio, (width, height)


def pool_args(parts: Sequence[Part], size: tuple[int, int], out: Path) -> list[str]:
    """ffmpeg arguments that cut every part and join them at 30 fps with 48 kHz stereo sound. A part of the
    pool's shape fills the frame (cropping what overflows); a part of another shape (a phone video in a
    landscape pool) is shown whole in the middle over a blurred, darkened copy of itself, so the 9:16 crop
    of a montage still shows all of it."""
    w, h = size
    args: list[str] = []
    graph: list[str] = []
    for path, s, e, _a, _size in parts:
        args += ["-ss", f"{s:.3f}", "-t", f"{e - s + 0.5:.3f}", "-i", str(path)]
    labels = []
    tail = "setsar=1,format=yuv420p,trim=duration={d},setpts=PTS-STARTPTS"
    for i, (_path, s, e, has_audio, (iw, ih)) in enumerate(parts):
        d = f"{e - s:.3f}"
        fill = f"scale={w}:{h}:force_original_aspect_ratio=increase:out_color_matrix=bt709,crop={w}:{h}"
        if iw and ih and shape_of(iw, ih) != shape_of(w, h):
            graph.append(f"[{i}:v:0]fps={FPS},split=2[bg{i}][fg{i}]")
            graph.append(f"[bg{i}]{fill},boxblur=24:2,eq=brightness=-0.12[bb{i}]")
            graph.append(f"[fg{i}]scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709[ff{i}]")
            graph.append(f"[bb{i}][ff{i}]overlay=(W-w)/2:(H-h)/2," + tail.format(d=d) + f"[v{i}]")
        else:
            graph.append(f"[{i}:v:0]fps={FPS},{fill}," + tail.format(d=d) + f"[v{i}]")
        if has_audio:
            graph.append(
                f"[{i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"apad,atrim=duration={d},asetpts=PTS-STARTPTS[a{i}]"
            )
        else:
            graph.append(f"anullsrc=r=48000:cl=stereo,atrim=duration={d}[a{i}]")
        labels.append(f"[v{i}][a{i}]")
    graph.append("".join(labels) + f"concat=n={len(parts)}:v=1:a=1[outv][outa]")
    return args + [
        "-filter_complex", ";".join(graph), "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out),
    ]


def pool_words(scenes: Sequence[dict[str, Any]], words_by_input: dict[str, list[dict[str, Any]]],
               starts: dict[str, tuple[float, float]]) -> list[dict[str, Any]]:
    """The words spoken inside each scene, moved to pool time. `starts` maps scene id -> (pool start,
    input start)."""
    out: list[dict[str, Any]] = []
    for sc in scenes:
        p0, i0 = starts[str(sc["id"])]
        dur = float(sc["e"]) - float(sc["s"])
        for w in words_by_input.get(str(sc["from"]), []):
            ws, we = float(w["s"]) - i0, float(w["e"]) - i0
            if ws < -0.05 or we > dur + 0.05 or we <= ws:
                continue
            nw = {**w, "s": round(p0 + max(0.0, ws), 3), "e": round(p0 + min(dur, we), 3)}
            out.append(nw)
    out.sort(key=lambda w: w["s"])
    return out


# ── the job ───────────────────────────────────────────────────────────────
def _options(project: dict[str, Any], payload: dict[str, Any]) -> tuple[int, float, float]:
    opts = {**(project.get("options") or {}), **{k: v for k, v in payload.items() if v not in (None, "")}}
    try:
        count = max(1, min(50, int(opts.get("count") or DEFAULT_COUNT)))
        lo = float(opts.get("minSec") or DEFAULT_MIN_SEC)
        hi = float(opts.get("maxSec") or DEFAULT_MAX_SEC)
    except (TypeError, ValueError):
        raise PermanentError("count, minSec and maxSec must be numbers") from None
    lo = max(3.0, min(120.0, lo))
    hi = max(lo, min(180.0, hi))
    return count, lo, hi


def _current_pool(db: Any, project_id: str) -> Optional[dict[str, Any]]:
    return db.one("source_videos", "select * from source_videos where project_id = ? and role = 'pool' "
                  "and status = 'ready' order by created_at desc limit 1", project_id)


def build_pool(ctx: JobContext, project_id: str, inputs: list[dict[str, Any]]) -> dict[str, Any]:
    db = ctx.db
    n = len(inputs)
    words_by_input: dict[str, list[dict[str, Any]]] = {}
    scenes_by_input: dict[str, list[Scene]] = {}
    language = None
    from .transcribe import transcribe  # heavy imports (Whisper) only when a montage is made

    for i, src in enumerate(inputs):
        sub = ctx.sub(0.05 + 0.6 * i / n, 0.05 + 0.6 * (i + 1) / n)
        sub.progress(0.0, f"Listening to video {i + 1} of {n}", force=True)
        src = ingest(sub.sub(0.0, 0.3), src["id"])
        tr = transcribe(sub.sub(0.3, 0.95), src["id"])
        language = language or tr.get("language")
        words_by_input[src["id"]] = list(tr.get("words") or [])
        sub.progress(0.97, f"Finding the best moments of video {i + 1} of {n}", force=True)
        scenes_by_input[src["id"]] = find_scenes(words_by_input[src["id"]], src.get("energy"), src.get("scene_cuts") or [],
                                                 float(src.get("duration_sec") or 0))
        inputs[i] = src

    per_video = max(3, min(MAX_SCENES_PER_VIDEO, MAX_POOL_SCENES // max(1, n)))
    size = canvas_for([(int(s.get("width") or 0), int(s.get("height") or 0)) for s in inputs if s.get("width")])
    scenes: list[dict[str, Any]] = []
    parts: list[Part] = []
    starts: dict[str, tuple[float, float]] = {}
    t = 0.0
    for vi, src in enumerate(inputs):
        path = source_file(ctx, src)
        has_audio = bool(src.get("audio_key"))
        try:
            has_audio = ffmpeg.probe(path)["has_audio"]
        except ffmpeg.FfmpegError:
            pass
        iw, ih = int(src.get("width") or 0), int(src.get("height") or 0)
        # shown whole in the middle of a frame of another shape (pool_args): its pieces crop the middle
        fit = bool(iw and ih) and shape_of(iw, ih) != shape_of(*size) and shape_of(*size) != "v"
        mine = sorted(scenes_by_input[src["id"]][:per_video], key=lambda sc: sc.s)
        for k, sc in enumerate(mine):
            sid = f"s{vi}_{k}"
            d = round(sc.duration, 3)
            # whole frames, so pool times and the 30 fps grid agree
            d = max(1, round(d * FPS)) / FPS
            scenes.append({"id": sid, "s": round(t, 3), "e": round(t + d, 3), "from": src["id"],
                           "name": src.get("filename") or f"Video {vi + 1}", "score": sc.score,
                           "srcStart": sc.s, "kind": sc.kind, **({"fit": True} if fit else {})})
            starts[sid] = (round(t, 3), sc.s)
            parts.append((path, sc.s, sc.s + d, has_audio, (iw, ih)))
            t += d
    if not parts:
        raise PermanentError("no usable moments found in these videos")

    pool_id = db.insert("source_videos", {
        "project_id": project_id, "origin": "upload", "role": "pool", "filename": "Montage scenes",
        "status": "importing", "scenes": scenes,
    })
    key = f"sources/{pool_id}/source.mp4"
    out = ctx.settings.storage_path(key)
    tmp = out.with_name("source.part.mp4")
    ctx.progress(0.66, f"Cutting {len(parts)} scenes", force=True)
    try:
        ffmpeg.run_ffmpeg(pool_args(parts, size, tmp), duration=t, on_progress=lambda p: ctx.progress(0.66 + 0.2 * p))
        tmp.replace(out)
    except Exception:
        db.update("source_videos", pool_id, {"status": "failed", "error": "could not cut the scenes"})
        raise
    framing = "center" if size[1] > size[0] else "speaker"
    db.update("source_videos", pool_id, {"storage_key": key, "status": "pending", "framing": framing})
    pool = ingest(ctx.sub(0.86, 0.9), pool_id)
    words = pool_words(scenes, words_by_input, starts)
    db.insert("transcripts", {
        "source_video_id": pool_id, "language": language, "words": words,
        "segments": seg.sentences_to_segments(seg.build_sentences(words)),
        "speakers": sorted({w["spk"] for w in words if w.get("spk")}) or ["S1"], "model": "montage",
    })
    return pool


def montage(ctx: JobContext, project_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    db = ctx.db
    project = db.get("projects", project_id)
    if project is None:
        raise PermanentError("project not found")
    count, lo, hi = _options(project, payload)
    opts = {**(project.get("options") or {}), "count": count, "minSec": lo, "maxSec": hi}
    db.update("projects", project_id, {"options": opts})
    inputs = db.many("source_videos", "select * from source_videos where project_id = ? and role = 'input' "
                     "and status not in ('deleted', 'failed', 'uploading') order by created_at", project_id)
    if not inputs:
        raise PermanentError("add at least one video first")
    ids = sorted(s["id"] for s in inputs)

    pool = _current_pool(db, project_id)
    if pool is None or sorted(opts.get("poolInputs") or []) != ids:
        # new or changed videos: cut a new pool (the montages made from the old one keep working)
        pool = build_pool(ctx, project_id, inputs)
        opts = {**opts, "poolInputs": ids}
        db.update("projects", project_id, {"options": opts})
    scenes = pool.get("scenes") or []
    tr = db.one("transcripts", "select * from transcripts where source_video_id = ?", pool["id"]) or {}

    existing = db.many("clips", "select * from clips where source_video_id = ?", pool["id"])
    made = [[_scene_at(scenes, p) for p in (c.get("edit_state") or {}).get("video") or []] for c in existing]
    plans = compose(scenes, count, lo, hi, seed=None, avoid=[[x for x in m if x] for m in made])
    if not plans:
        raise PermanentError("no usable moments found in these videos")

    from .reframe import reframe  # face tracking imports only when needed
    clip_ids: list[str] = []
    render_ids: list[str] = []
    number = len(db.many("clips", "select id from clips where project_id = ?", project_id))
    # Every montage spans the whole pool (its pieces pick the scenes), so one crop track serves them all
    # and any scene added in the editor is already framed.
    pool_end = round(float(db.get("source_videos", pool["id"])["duration_sec"] or scenes[-1]["e"]), 3)  # type: ignore[index]
    shared_track = next((c["crop_track"] for c in existing if c.get("crop_track")), None)
    for k, pieces in enumerate(plans):
        number += 1
        start, end = 0.0, pool_end
        names = []
        for p in pieces:
            sc = next((x for x in scenes if x["id"] == p["scene"]), None)
            if sc and sc.get("name") not in names:
                names.append(sc.get("name"))
        cid = db.insert("clips", {
            "project_id": project_id, "source_video_id": pool["id"], "start_sec": start, "end_sec": end,
            "title": f"Montage {number}", "reason": "Mixed from " + ", ".join(str(n) for n in names),
            "status": "candidate", "caption_style_id": "bold-outline",
            "edit_state": montage_edit(pieces, tr.get("words") or [], scenes=scenes),
        })
        clip_ids.append(cid)
        if shared_track is None:
            ctx.sub(0.9, 0.99).progress(0.0, "Framing the scenes", force=True)
            shared_track = reframe(ctx.sub(0.9, 0.99), cid)
        else:
            db.update("clips", cid, {"crop_track": shared_track})
        rid = db.insert("renders", {"clip_id": cid, "status": "queued", "options": {}})
        render_ids.append(rid)
        db.enqueue("render", {"render_id": rid}, project_id=project_id, dedupe_key=f"render:{rid}", parent_job_id=ctx.job["id"])
    ctx.progress(1.0, f"Made {len(clip_ids)} montages", force=True)
    return {"pool_source_id": pool["id"], "clip_ids": clip_ids, "render_ids": render_ids, "scenes": len(scenes)}


def _scene_at(scenes: Sequence[dict[str, Any]], piece: dict[str, Any]) -> Optional[str]:
    t = float(piece.get("srcStart") or 0) + 0.01
    return next((str(sc["id"]) for sc in scenes if float(sc["s"]) <= t < float(sc["e"])), None)


def handle_montage(ctx: JobContext) -> dict[str, Any]:
    pid = ctx.payload.get("project_id")
    if not pid:
        raise PermanentError("payload.project_id is required")
    return montage(ctx, pid, ctx.payload)


HANDLERS = {"montage": handle_montage}
