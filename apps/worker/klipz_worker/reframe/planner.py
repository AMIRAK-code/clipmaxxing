"""Pure reframing logic: detections + diarization + shot cuts -> CropTrack.

Nothing here touches video, MediaPipe or the database, so it is fully testable
with synthetic detections."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional, Sequence

from .detect import Face
from .oneeuro import dead_zone, smooth_series

OUT_ASPECT = 1080 / 1920
SPLIT_ASPECT = 1080 / 960  # each half of the stacked layout


@dataclass
class Sample:
    t: float  # absolute source seconds
    faces: list[Face] = field(default_factory=list)
    motion: float = 0.0  # mean abs frame difference vs the previous sample, 0..1
    edge: float = 0.0  # fraction of strong-edge pixels (text/UI-like content), 0..1


@dataclass
class PlanConfig:
    min_shot: float = 0.5  # cuts closer than this to a clip edge are ignored
    max_gap: float = 1.0  # a face track survives this long without detections
    speaker_hold: float = 1.0  # a new speaker must hold the floor this long
    speech_merge_gap: float = 0.6  # words of one speaker closer than this form one turn
    min_cutoff: float = 0.4
    beta: float = 1.0
    dead_zone: float = 0.015  # normalised; ignore smaller motion
    key_eps: float = 0.008  # keyframe simplification tolerance (normalised)
    max_keys_per_sec: float = 2.0
    no_face_presence: float = 0.15  # below this fraction of samples a shot counts as "no faces"
    split_presence: float = 0.6  # both faces visible in at least this fraction of the shot
    split_min_talk: float = 0.8  # both speakers talk at least this long within the shot
    split_min_sep: float = 0.12  # min horizontal separation of the two faces (normalised)
    screen_motion: float = 0.02  # low motion ...
    screen_edge: float = 0.06  # ... or lots of text-like edges => screen content
    min_source_height: int = 360  # below this a 9:16 crop would be absurdly upscaled


# ── window geometry ─────────────────────────────────────────────────────────
def window_norm(src_w: float, src_h: float, aspect: float) -> tuple[float, float]:
    """Largest window of `aspect` inside the source, as fractions of the source size."""
    w, h = float(src_w), src_w / aspect
    if h > src_h:
        h, w = float(src_h), src_h * aspect
    return min(1.0, w / src_w), min(1.0, h / src_h)


def clamp_center(cx: float, cy: float, ww: float, wh: float) -> tuple[float, float]:
    """Keep the window inside the frame."""
    return (min(max(cx, ww / 2), 1 - ww / 2), min(max(cy, wh / 2), 1 - wh / 2))


# ── face tracks ──────────────────────────────────────────────────────────────
@dataclass
class Track:
    id: int
    obs: dict[int, Face] = field(default_factory=dict)  # sample index -> face

    @property
    def first(self) -> int:
        return min(self.obs)

    @property
    def last(self) -> int:
        return max(self.obs)

    def at(self, i: int) -> Optional[tuple[float, float]]:
        """Face centre at sample i, linearly interpolated across gaps; None outside the track."""
        f = self.obs.get(i)
        if f is not None:
            return f.cx, f.cy
        if i < self.first or i > self.last:
            return None
        lo = max(j for j in self.obs if j < i)
        hi = min(j for j in self.obs if j > i)
        a, b = self.obs[lo], self.obs[hi]
        k = (i - lo) / (hi - lo)
        return a.cx + (b.cx - a.cx) * k, a.cy + (b.cy - a.cy) * k

    def prominence(self) -> float:
        """Sum of size x centrality: how much of the shot this face dominates."""
        return sum(f.area * (1.0 - min(1.0, abs(f.cx - 0.5) * 1.2)) for f in self.obs.values())


def link_tracks(faces_per_sample: Sequence[Sequence[Face]], times: Sequence[float], max_gap: float = 1.0) -> list[Track]:
    """Greedy nearest-centre association with gap tolerance."""
    tracks: list[Track] = []
    for i, faces in enumerate(faces_per_sample):
        live = [tr for tr in tracks if times[i] - times[tr.last] <= max_gap + 1e-9]
        pairs: list[tuple[float, int, int]] = []
        for ti, tr in enumerate(live):
            last = tr.obs[tr.last]
            gap_samples = max(1, i - tr.last)
            for fi, f in enumerate(faces):
                d = math.hypot(f.cx - last.cx, f.cy - last.cy)
                thr = (0.08 + 1.0 * max(last.w, f.w)) * (1 + 0.5 * (gap_samples - 1))
                if d <= thr:
                    pairs.append((d, ti, fi))
        pairs.sort()
        used_t: set[int] = set()
        used_f: set[int] = set()
        for _d, ti, fi in pairs:
            if ti in used_t or fi in used_f:
                continue
            live[ti].obs[i] = faces[fi]
            used_t.add(ti)
            used_f.add(fi)
        for fi, f in enumerate(faces):
            if fi not in used_f:
                tracks.append(Track(id=len(tracks), obs={i: f}))
    return tracks


# ── diarization helpers ──────────────────────────────────────────────────────
def speech_turns(words: Sequence[dict[str, Any]], merge_gap: float = 0.6) -> list[tuple[str, float, float]]:
    """Merge consecutive words of one speaker into (spk, start, end) turns."""
    turns: list[list[Any]] = []
    for w in sorted(words, key=lambda x: float(x["s"])):
        spk = str(w.get("spk") or "S1")
        s, e = float(w["s"]), float(w["e"])
        if turns and turns[-1][0] == spk and s - turns[-1][2] <= merge_gap:
            turns[-1][2] = max(turns[-1][2], e)
        else:
            turns.append([spk, s, e])
    return [(a, b, c) for a, b, c in turns]


def speaker_at(turns: Sequence[tuple[str, float, float]], t: float, slack: float = 0.15) -> Optional[str]:
    best: Optional[str] = None
    best_d = 1e9
    for spk, s, e in turns:
        if s - slack <= t <= e + slack:
            d = 0.0 if s <= t <= e else min(abs(t - s), abs(t - e))
            if d < best_d:
                best, best_d = spk, d
    return best


def stable_speakers(raw: Sequence[Optional[str]], times: Sequence[float], hold: float = 1.0) -> list[Optional[str]]:
    """Hysteresis: the active speaker only changes after another speaker has held
    the floor for `hold` seconds; the change is applied from where they began
    (no late pan) but short interjections never move the crop."""
    out: list[Optional[str]] = [None] * len(raw)
    cur: Optional[str] = None
    cand: Optional[str] = None
    cand_i = 0
    for i, r in enumerate(raw):
        if r is None:
            pass
        elif cur is None:
            cur = r
            cand = None
        elif r == cur:
            cand = None
        elif cand != r:
            cand, cand_i = r, i
        elif times[i] - times[cand_i] >= hold - 1e-9:
            cur = r
            for j in range(cand_i, i):
                out[j] = cur
            cand = None
        out[i] = cur
    first = next((x for x in out if x is not None), None)
    return [first if x is None else x for x in out]


def mouth_activity(track: Track, n: int) -> list[Optional[float]]:
    """|Δ mouth openness| between consecutive samples where both were detected."""
    act: list[Optional[float]] = [None] * n
    for i, f in track.obs.items():
        p = track.obs.get(i - 1)
        if f.mouth is not None and p is not None and p.mouth is not None:
            act[i] = abs(f.mouth - p.mouth)
    return act


def assign_speakers(
    tracks: Sequence[Track], raw: Sequence[Optional[str]], n: int, min_samples: int = 3, eps: float = 1e-4
) -> dict[str, int]:
    """speaker -> track id from co-occurrence of talking time with mouth movement.
    Score = mean activity while the speaker talks minus while others talk/silence."""
    acts = {tr.id: mouth_activity(tr, n) for tr in tracks}
    speakers = sorted({s for s in raw if s is not None})
    scored: list[tuple[float, str, int]] = []
    for spk in speakers:
        inside = [i for i in range(n) if raw[i] == spk]
        outside = [i for i in range(n) if raw[i] != spk]
        for tr in tracks:
            a = acts[tr.id]
            ins = [a[i] for i in inside if a[i] is not None]
            if len(ins) < min_samples:
                continue
            outs = [a[i] for i in outside if a[i] is not None]
            base = sum(outs) / len(outs) if len(outs) >= min_samples else 0.0  # type: ignore[arg-type]
            score = sum(ins) / len(ins) - base  # type: ignore[arg-type]
            if score > eps:
                scored.append((score, spk, tr.id))
    scored.sort(reverse=True)
    mapping: dict[str, int] = {}
    used: set[int] = set()
    for _s, spk, tid in scored:
        if spk in mapping or tid in used:
            continue
        mapping[spk] = tid
        used.add(tid)
    return mapping


# ── keyframes ────────────────────────────────────────────────────────────────
def simplify_keys(
    pts: Sequence[tuple[float, float, float]], eps: float, max_keys: int
) -> list[tuple[float, float, float]]:
    """Ramer-Douglas-Peucker on (cx, cy) value error; drops collinear keys, then
    loosens eps until at most `max_keys` remain. A static path becomes one key."""
    pts = list(pts)
    if len(pts) <= 1:
        return pts

    def rdp(e: float) -> list[tuple[float, float, float]]:
        keep = {0, len(pts) - 1}
        stack = [(0, len(pts) - 1)]
        while stack:
            lo, hi = stack.pop()
            t0, x0, y0 = pts[lo]
            t1, x1, y1 = pts[hi]
            worst, wi = 0.0, -1
            for k in range(lo + 1, hi):
                tk, xk, yk = pts[k]
                u = (tk - t0) / (t1 - t0) if t1 > t0 else 0.0
                err = max(abs(xk - (x0 + (x1 - x0) * u)), abs(yk - (y0 + (y1 - y0) * u)))
                if err > worst:
                    worst, wi = err, k
            if wi >= 0 and worst > e:
                keep.add(wi)
                stack += [(lo, wi), (wi, hi)]
        return [pts[i] for i in sorted(keep)]

    out = rdp(eps)
    while len(out) > max_keys and eps < 1.0:
        eps *= 1.5
        out = rdp(eps)
    if len(out) == 2 and max(abs(out[0][1] - out[1][1]), abs(out[0][2] - out[1][2])) <= eps:
        out = [out[0]]
    return out


def _path_to_keys(
    start: float, end: float, times: Sequence[float], xs: Sequence[float], ys: Sequence[float], cfg: PlanConfig
) -> list[dict[str, float]]:
    pts: list[tuple[float, float, float]] = []
    if times:
        pts.append((start, xs[0], ys[0]))
        for t, x, y in zip(times, xs, ys):
            if t > pts[-1][0] + 1e-6:
                pts.append((min(t, end), x, y))
        if end > pts[-1][0] + 1e-6:
            pts.append((end, xs[-1], ys[-1]))
    else:
        pts.append((start, 0.5, 0.5))
    max_keys = max(2, int(math.ceil(cfg.max_keys_per_sec * (end - start))) + 1)
    simp = simplify_keys(pts, cfg.key_eps, max_keys)
    return [{"t": round(t, 3), "cx": round(x, 4), "cy": round(y, 4)} for t, x, y in simp]


def _smooth_path(
    times: Sequence[float], xs: Sequence[float], ys: Sequence[float], ww: float, wh: float, cfg: PlanConfig
) -> tuple[list[float], list[float]]:
    cl = [clamp_center(x, y, ww, wh) for x, y in zip(xs, ys)]
    sx = dead_zone(smooth_series(times, [c[0] for c in cl], cfg.min_cutoff, cfg.beta), cfg.dead_zone)
    sy = dead_zone(smooth_series(times, [c[1] for c in cl], cfg.min_cutoff, cfg.beta), cfg.dead_zone)
    out = [clamp_center(x, y, ww, wh) for x, y in zip(sx, sy)]
    return [o[0] for o in out], [o[1] for o in out]


# ── shot planning ────────────────────────────────────────────────────────────
@dataclass
class ShotInfo:
    start: float
    end: float
    layout: str
    reason: str
    presence: float = 0.0
    tracks: int = 0
    speakers: dict[str, int] = field(default_factory=dict)


def shot_boundaries(start: float, end: float, cuts: Sequence[float], min_shot: float) -> list[float]:
    inner: list[float] = []
    for c in sorted(float(x) for x in cuts):
        if start + min_shot <= c <= end - min_shot and (not inner or c - inner[-1] >= min_shot):
            inner.append(c)
    return [start, *inner, end]


def _follow_subject(
    tracks: list[Track], times: Sequence[float], turns: Sequence[tuple[str, float, float]], cfg: PlanConfig
) -> tuple[list[Optional[tuple[float, float]]], dict[str, int]]:
    n = len(times)
    raw = [speaker_at(turns, t) for t in times]
    eff = stable_speakers(raw, times, cfg.speaker_hold)
    mapping = assign_speakers(tracks, raw, n)
    default = max(tracks, key=lambda tr: tr.prominence())
    by_id = {tr.id: tr for tr in tracks}
    pos: list[Optional[tuple[float, float]]] = []
    prev: Optional[Track] = None
    for i in range(n):
        want = by_id.get(mapping[eff[i]]) if eff[i] in mapping else None  # type: ignore[index]
        cur: Optional[Track] = None
        if want is not None and want.at(i) is not None:
            cur = want
        elif prev is not None and prev.at(i) is not None:
            cur = prev
        elif default.at(i) is not None:
            cur = default
        else:
            present = [tr for tr in tracks if tr.at(i) is not None]
            cur = max(present, key=lambda tr: tr.prominence()) if present else None
        prev = cur if cur is not None else prev
        pos.append(cur.at(i) if cur is not None else None)
    return pos, mapping


def _fill(pos: list[Optional[tuple[float, float]]]) -> list[tuple[float, float]]:
    first = next((p for p in pos if p is not None), (0.5, 0.5))
    out: list[tuple[float, float]] = []
    last = first
    for p in pos:
        last = p if p is not None else last
        out.append(last)
    return out


def plan_shot(
    start: float,
    end: float,
    samples: Sequence[Sample],
    words: Sequence[dict[str, Any]],
    src_w: int,
    src_h: int,
    cfg: PlanConfig,
) -> tuple[dict[str, Any], ShotInfo]:
    aspect_src = src_w / src_h
    landscape = aspect_src >= 1.2
    ww, wh = window_norm(src_w, src_h, OUT_ASPECT)
    centre = [{"t": round(start, 3), "cx": 0.5, "cy": 0.5}]
    seg: dict[str, Any] = {"start": start, "end": end, "layout": "crop", "keys": centre}

    inside = [s for s in samples if start - 1e-9 <= s.t < end - 1e-9]
    if not inside and samples:
        inside = [min(samples, key=lambda s: abs(s.t - (start + end) / 2))]
    n = len(inside)
    times = [s.t for s in inside]
    presence = sum(1 for s in inside if s.faces) / n if n else 0.0
    info = ShotInfo(start, end, "crop", "centre", presence)

    if src_h < cfg.min_source_height:
        seg["layout"] = "letterbox"
        info.layout, info.reason = "letterbox", "tiny-source"
        return seg, info

    if n == 0 or presence < cfg.no_face_presence:
        # no people: slides/screen/gameplay get the full frame; everything else the centre
        stat = inside[1:] if len(inside) > 1 else inside  # first sample of a shot straddles the cut
        motion = sum(s.motion for s in stat) / len(stat) if stat else 1.0
        edge = sum(s.edge for s in stat) / len(stat) if stat else 0.0
        if landscape and (motion < cfg.screen_motion or edge > cfg.screen_edge):
            seg["layout"] = "letterbox"
            info.layout, info.reason = "letterbox", "screen-content"
        else:
            info.reason = "no-faces"
        return seg, info

    tracks = link_tracks([s.faces for s in inside], times, cfg.max_gap)
    info.tracks = len(tracks)
    turns = [t for t in speech_turns(words, cfg.speech_merge_gap) if t[2] > start and t[1] < end]

    # stacked split: two faces visible most of the shot and both people talk in it
    if landscape and len(tracks) >= 2:
        pres = sorted(tracks, key=lambda tr: len(tr.obs), reverse=True)[:2]
        if all(len(tr.obs) / n >= cfg.split_presence for tr in pres):
            talk: dict[str, float] = {}
            for spk, s, e in turns:
                talk[spk] = talk.get(spk, 0.0) + max(0.0, min(e, end) - max(s, start))
            talkers = [k for k, v in talk.items() if v >= cfg.split_min_talk]
            mean_x = [sum(f.cx for f in tr.obs.values()) / len(tr.obs) for tr in pres]
            if len(talkers) >= 2 and abs(mean_x[0] - mean_x[1]) >= cfg.split_min_sep:
                left, right = (pres[0], pres[1]) if mean_x[0] <= mean_x[1] else (pres[1], pres[0])
                sw, sh = window_norm(src_w, src_h, SPLIT_ASPECT)
                keys = []
                for tr in (left, right):
                    fill = _fill([tr.at(i) for i in range(n)])
                    xs, ys = _smooth_path(times, [p[0] for p in fill], [p[1] for p in fill], sw, sh, cfg)
                    keys.append(_path_to_keys(start, end, times, xs, ys, cfg))
                seg.update(layout="split", keys=keys[0], keys2=keys[1])
                info.layout, info.reason = "split", "two-speakers"
                return seg, info

    pos, mapping = _follow_subject(tracks, times, turns, cfg)
    info.speakers = mapping
    fill = _fill(pos)
    xs, ys = _smooth_path(times, [p[0] for p in fill], [p[1] for p in fill], ww, wh, cfg)
    seg["keys"] = _path_to_keys(start, end, times, xs, ys, cfg)
    info.reason = "speaker-follow" if mapping else "prominent-face"
    return seg, info


def plan_track(
    *,
    start: float,
    end: float,
    src_w: int,
    src_h: int,
    samples: Sequence[Sample],
    cuts: Sequence[float],
    words: Sequence[dict[str, Any]],
    cfg: Optional[PlanConfig] = None,
) -> tuple[dict[str, Any], list[ShotInfo]]:
    """CropTrack dict (segments tile [start, end] exactly) plus per-shot decisions."""
    cfg = cfg or PlanConfig()
    bounds = shot_boundaries(start, end, cuts, cfg.min_shot)
    segs: list[dict[str, Any]] = []
    infos: list[ShotInfo] = []
    for a, b in zip(bounds, bounds[1:]):
        seg, info = plan_shot(a, b, samples, words, src_w, src_h, cfg)
        segs.append(seg)
        infos.append(info)
    return {"version": 1, "srcW": int(src_w), "srcH": int(src_h), "segments": segs}, infos
