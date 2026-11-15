"""The FFmpeg inputs and filter graph for a clip: cuts, reframing, zoom, captions, progress bar.

Everything that varies per frame (face-tracking crop position, zoom) is computed here with the ported
model functions, exactly as the React components compute it for the Remotion renderer, and handed to
FFmpeg as data (sendcmd scripts). FFmpeg itself makes no layout decisions.

Frame bookkeeping matches MainTrack.tsx: piece i covers output frames [from_i, from_i + n_i) and its
frame f shows the source frame at (round(srcStart * fps) + f) / fps, laid out for source time
srcStart + f / fps.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Sequence

from . import model as m
from .text import Color, parse_color

FPS = m.OUT_FPS
# pieces further apart than this in the source get their own input (seek) instead of decoding the gap
MAX_SPAN_GAP_SEC = 20.0


@dataclass
class Plan:
    inputs: list[list[str]]                 # ffmpeg arguments per input, each ending with "-i", <source>
    graph: str                              # filter graph text
    files: dict[str, str] = field(default_factory=dict)   # sendcmd scripts: relative name -> content
    total_frames: int = 0
    video_out: str = "outv"
    audio_out: str = "outa"


def _even_down(x: float) -> int:
    return max(2, int(x) // 2 * 2)


def _even_up(x: float) -> int:
    i = int(x) if x == int(x) else int(x) + 1
    return i + (i % 2)


def _even_near(x: float, limit: int) -> int:
    """Nearest even integer, at least 2 and at most `limit`."""
    return max(2, min(limit, int(round(x / 2)) * 2))


def _f(x: float) -> str:
    s = f"{x:.6f}".rstrip("0").rstrip(".")
    return s or "0"


class _Builder:
    def __init__(self, src_w: int, src_h: int) -> None:
        self.src_w, self.src_h = src_w - src_w % 2, src_h - src_h % 2
        self.parts: list[str] = []
        self.files: dict[str, str] = {}
        self._uid = 0

    def uid(self, prefix: str) -> str:
        self._uid += 1
        return f"{prefix}{self._uid}"

    # ── one pane: a moving window of the source scaled to out_w x out_h ──
    def pane(self, rects: Sequence[m.Rect], out_w: int, out_h: int) -> str:
        """Filter chain (without labels) that shows the source window rects[f] on frame f of the chain."""
        r0 = rects[0]
        moving = any(abs(r.x - r0.x) > 0.25 or abs(r.y - r0.y) > 0.25 for r in rects)
        if not moving:
            w, h = min(_even_down(r0.w), self.src_w), min(_even_down(r0.h), self.src_h)
            x = min(max(0, int(round(r0.x)) // 2 * 2), self.src_w - w)
            y = min(max(0, int(round(r0.y)) // 2 * 2), self.src_h - h)
            crop = "" if (w, h, x, y) == (self.src_w, self.src_h, 0, 0) else f"crop={w}:{h}:{x}:{y},"
            return f"{crop}scale={out_w}:{out_h}:flags=bicubic,setsar=1"

        # Moving window: a coarse crop on even source pixels with a small margin, scale, then a fine crop in
        # output pixels. A single crop could only move in whole source pixels (2-3 output pixels), which
        # shows as judder on slow face-tracking pans; the browser positions the video with sub-pixel precision.
        wc = min(self.src_w, _even_up(r0.w) + 8)
        hc = min(self.src_h, _even_up(r0.h) + 8)
        sx, sy = out_w / r0.w, out_h / r0.h
        ws, hs = max(out_w, _even_up(wc * sx)), max(out_h, _even_up(hc * sy))
        a, b = self.uid("ca"), self.uid("cb")
        lines: list[str] = []
        first: Optional[tuple[int, int, int, int]] = None
        prev: Optional[tuple[int, int, int, int]] = None
        for f, r in enumerate(rects):
            x0 = min(max(int(r.x) // 2 * 2 - 4, 0), self.src_w - wc)
            y0 = min(max(int(r.y) // 2 * 2 - 4, 0), self.src_h - hc)
            fx = min(max(int(round((r.x - x0) * ws / wc)), 0), ws - out_w)
            fy = min(max(int(round((r.y - y0) * hs / hc)), 0), hs - out_h)
            cur = (x0, y0, fx, fy)
            if first is None:
                first = cur
            elif cur != prev:
                t = max(0.0, (f - 0.5) / FPS)
                lines.append(f"{t:.5f} crop@{a} x {x0}, crop@{a} y {y0}, crop@{b} x {fx}, crop@{b} y {fy};")
            prev = cur
        assert first is not None
        name = f"{a}.cmd"
        self.files[name] = "\n".join(lines) + "\n"
        return (
            f"sendcmd=f={name},crop@{a}={wc}:{hc}:{first[0]}:{first[1]},scale={ws}:{hs}:flags=bicubic,"
            f"crop@{b}={out_w}:{out_h}:{first[2]}:{first[3]},setsar=1"
        )

    # ── a run of frames that share a layout kind ──
    def layout(self, src: str, out: str, kind: str, frames: Sequence[m.FrameLayout]) -> None:
        if kind == "crop":
            self.parts.append(f"[{src}]{self.pane([fl.panes[0].src for fl in frames], m.OUT_W, m.OUT_H)}[{out}]")
            return
        if kind == "split":
            top, bot, a, b = self.uid("t"), self.uid("b"), self.uid("ta"), self.uid("ba")
            half = m.OUT_H // 2
            self.parts.append(f"[{src}]split=2[{top}][{bot}]")
            self.parts.append(f"[{top}]{self.pane([fl.panes[0].src for fl in frames], m.OUT_W, half)}[{a}]")
            self.parts.append(f"[{bot}]{self.pane([fl.panes[1].src for fl in frames], m.OUT_W, half)}[{b}]")
            self.parts.append(f"[{a}][{b}]vstack=inputs=2,setsar=1[{out}]")
            return
        # letterbox: the whole source at full width over a blurred, darkened, enlarged copy of itself
        # (MainTrack.tsx: cover-scaled video, filter blur(36px) brightness(0.55), transform scale(1.15)).
        pane_h = _even_near(m.OUT_W * self.src_h / self.src_w, m.OUT_H)
        if pane_h >= m.OUT_H:
            self.parts.append(f"[{src}]scale={m.OUT_W}:{m.OUT_H}:flags=bicubic,setsar=1[{out}]")
            return
        fg, bg, fgs, bgs = self.uid("f"), self.uid("g"), self.uid("fs"), self.uid("gs")
        q = 4  # the background is blurred at quarter resolution: same look, a fraction of the work
        qw, qh = m.OUT_W // q, m.OUT_H // q
        cover = max(m.OUT_W / self.src_w, m.OUT_H / self.src_h) / q
        cw, ch = max(qw, _even_up(self.src_w * cover)), max(qh, _even_up(self.src_h * cover))
        sigma = 36 / q
        margin = _even_up(3 * sigma)
        # transform: scale(1.15) = show the centre 1/1.15 of the blurred box
        zw, zh = _even_near(qw / 1.15, qw), _even_near(qh / 1.15, qh)
        self.parts.append(f"[{src}]split=2[{fg}][{bg}]")
        self.parts.append(
            f"[{bg}]scale={cw}:{ch}:flags=bilinear,crop={qw}:{qh},"
            # CSS blurs the clipped box against transparency, so its edges fade towards the black page
            f"pad={qw + 2 * margin}:{qh + 2 * margin}:{margin}:{margin}:black,gblur=sigma={_f(sigma)}:steps=2,"
            f"crop={zw}:{zh},colorchannelmixer=rr=0.55:gg=0.55:bb=0.55,"
            f"scale={m.OUT_W}:{m.OUT_H}:flags=bilinear,format=yuv420p,setsar=1[{bgs}]"
        )
        self.parts.append(f"[{fg}]scale={m.OUT_W}:{pane_h}:flags=bicubic,setsar=1[{fgs}]")
        self.parts.append(f"[{bgs}][{fgs}]overlay=0:{(m.OUT_H - pane_h) // 2}:shortest=1,setsar=1[{out}]")

    # ── zoom keys ──
    def zoom(self, zooms: Sequence[dict[str, Any]], total_frames: int) -> Optional[str]:
        """Filters that apply the zoom keys, or None when the clip never zooms.

        The browser scales the whole video layer around the frame centre; the same picture comes from
        cropping a centred window of 1/zoom the size and scaling it back up. The window size per frame is
        the zoomAt() value the React component uses, sent to `crop` with sendcmd. On frames without zoom
        the crop is the whole frame and `scale` passes the frame through untouched, so unzoomed video
        costs nothing."""
        sizes: list[tuple[int, int]] = []
        for n in range(total_frames):
            z = max(1.0, m.zoom_at(zooms, n / FPS))
            sizes.append((_even_near(m.OUT_W / z, m.OUT_W), _even_near(m.OUT_H / z, m.OUT_H)))
        if all(sz == (m.OUT_W, m.OUT_H) for sz in sizes):
            return None
        lines: list[str] = []
        prev = sizes[0]
        for n, cur in enumerate(sizes):
            if n > 0 and cur != prev:
                t = max(0.0, (n - 0.5) / FPS)
                lines.append(f"{t:.5f} crop@zoom w {cur[0]}, crop@zoom h {cur[1]};")
            prev = cur
        self.files["zoom.cmd"] = "\n".join(lines) + "\n"
        return (f"sendcmd=f=zoom.cmd,crop@zoom={sizes[0][0]}:{sizes[0][1]}:(in_w-out_w)/2:(in_h-out_h)/2,"
                f"scale={m.OUT_W}:{m.OUT_H}:flags=bicubic,setsar=1")


@dataclass
class _Segment:
    """Consecutive output frames that come from one input and share a layout kind (and, for a crop, the
    size of the source window: one filter chain scales by one factor)."""
    kind: str
    key: tuple = ()
    ranges: list[list[int]] = field(default_factory=list)      # [start, end) in the span's 30 fps grid
    frames: list[m.FrameLayout] = field(default_factory=list)


@dataclass
class _Span:
    grid0: int                 # absolute 30 fps grid index of the span's first frame
    segments: list[_Segment] = field(default_factory=list)
    audio: list[tuple[int, int]] = field(default_factory=list)   # (start, end) grid indices per piece
    volumes: list[float] = field(default_factory=list)           # main-audio level per piece
    end: int = 0               # grid frames needed


def color_filters(matrix: str, full_range: bool) -> str:
    """Filters that turn the source into BT.709 limited-range frames and tag them as such.

    `matrix` is how the source must be read ("bt709" or "bt601"), decided like a browser does (see
    engine.source_color): the Remotion renderer and the editor preview show the video through Chrome,
    which reads untagged HD video as BT.709, while FFmpeg on its own would assume BT.601."""
    opts = []
    if matrix != "bt709":
        opts += [f"in_color_matrix={matrix}", "out_color_matrix=bt709"]
    if full_range:
        opts += ["in_range=pc", "out_range=tv"]
    convert = f"scale={':'.join(opts)}," if opts else ""
    # tag first so the explicit conversion (if any) is the only one: newer FFmpeg converts on its own
    # between differently tagged links
    pre = f"setparams=colorspace={'smpte170m' if matrix == 'bt601' else 'bt709'}:range={'pc' if full_range else 'tv'},"
    return f"{pre}{convert}format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv"


def build_plan(props: dict[str, Any], source_path: str, *, has_audio: bool, ass_file: Optional[str] = None,
               fonts_dir: str = "fonts", matrix: str = "bt709", full_range: bool = False,
               dim: Sequence[tuple[int, float]] = (), shaping: bool = False) -> Plan:
    """`ass_file` / `fonts_dir` are paths relative to the directory ffmpeg runs in (no escaping needed).
    `shaping` draws the script with libass's HarfBuzz shaper (ass.Script.shaped: Arabic-script text).
    `matrix` / `full_range` say how the source's colours must be read."""
    edit = props["edit"]
    pieces: list[dict[str, Any]] = edit["video"]
    src_w, src_h = int(props["srcW"]), int(props["srcH"])
    auto_track = props.get("cropTrack")
    frames = m.piece_frames(pieces)
    total = sum(n for _f0, n in frames)

    # Pieces that follow each other in the source share one seek + decode (a "span"); inside a span,
    # consecutive frames with the same layout kind share one filter chain (a "segment").
    spans: list[_Span] = []
    prev_end_grid: Optional[int] = None
    for piece, (_from, n) in zip(pieces, frames):
        g = m.js_round(float(piece["srcStart"]) * FPS)
        if prev_end_grid is None or g < prev_end_grid or (g - prev_end_grid) / FPS > MAX_SPAN_GAP_SEC:
            spans.append(_Span(grid0=g))
        span = spans[-1]
        local = g - span.grid0
        # after a split every piece can have its own crop (ClipComposition / MainTrack do the same)
        track = m.piece_crop_track(edit, piece, auto_track, src_w, src_h)
        for f in range(n):
            fl = m.layout_at(track, float(piece["srcStart"]) + f / FPS, src_w, src_h)
            # two pieces with different zooms show windows of different sizes: separate chains
            key = (fl.layout, round(fl.panes[0].src.w, 2), round(fl.panes[0].src.h, 2)) if fl.layout == "crop" else (fl.layout,)
            seg = span.segments[-1] if span.segments else None
            if seg is None or seg.key != key:
                seg = _Segment(fl.layout, key)
                span.segments.append(seg)
            idx = local + f
            if seg.ranges and seg.ranges[-1][1] == idx:
                seg.ranges[-1][1] = idx + 1
            else:
                seg.ranges.append([idx, idx + 1])
            seg.frames.append(fl)
        span.audio.append((local, local + n))
        span.volumes.append(m.piece_volume(edit, piece))
        span.end = local + n
        prev_end_grid = g + n

    # pieces with their own sound level get it on their own stretch; otherwise one gain for the whole clip
    own_levels = any(p.get("volume") is not None for p in pieces)
    b = _Builder(src_w, src_h)
    inputs: list[list[str]] = []
    v_labels: list[str] = []
    a_labels: list[str] = []
    for si, span in enumerate(spans):
        inputs.append(["-ss", _f(span.grid0 / FPS), "-t", _f(span.end / FPS + 1.0), "-i", source_path])
        base = f"v{si}"
        b.parts.append(
            f"[{si}:v:0]fps={FPS}:start_time=0,tpad=stop_mode=clone:stop_duration=2,trim=end_frame={span.end},"
            f"setpts=PTS-STARTPTS,{color_filters(matrix, full_range)}[{base}]"
        )
        branches = [base]
        if len(span.segments) > 1:
            branches = [f"{base}s{i}" for i in range(len(span.segments))]
            b.parts.append(f"[{base}]split={len(branches)}" + "".join(f"[{x}]" for x in branches))
        for gi, (seg, br) in enumerate(zip(span.segments, branches)):
            src = br
            if seg.ranges != [[0, span.end]]:
                keep = "+".join(f"between(n,{a},{e - 1})" for a, e in seg.ranges)
                src = f"{br}k"
                b.parts.append(f"[{br}]select='{keep}',setpts=N/FR/TB[{src}]")
            out = f"l{si}_{gi}"
            b.layout(src, out, seg.kind, seg.frames)
            v_labels.append(out)

        if has_audio:
            abase = f"a{si}"
            b.parts.append(
                f"[{si}:a:0]aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                f"apad=whole_dur={_f(span.end / FPS)}[{abase}]"
            )
            abr = [abase]
            if len(span.audio) > 1:
                abr = [f"{abase}p{i}" for i in range(len(span.audio))]
                b.parts.append(f"[{abase}]asplit={len(abr)}" + "".join(f"[{x}]" for x in abr))
            for pi, ((a0, a1), br) in enumerate(zip(span.audio, abr)):
                out = f"au{si}_{pi}"
                gain = f",volume={_f(max(0.0, span.volumes[pi]))}" if own_levels else ""
                b.parts.append(f"[{br}]atrim=start={_f(a0 / FPS)}:end={_f(a1 / FPS)},asetpts=PTS-STARTPTS{gain}[{out}]")
                a_labels.append(out)

    cur = v_labels[0]
    if len(v_labels) > 1:
        b.parts.append("".join(f"[{x}]" for x in v_labels) + f"concat=n={len(v_labels)}:v=1:a=0[cv]")
        cur = "cv"

    chain: list[str] = []
    zoom = b.zoom(edit.get("zooms") or [], total)
    if zoom:
        chain.append(zoom)
    if len(dim) >= 2:
        # The hook card's dim: black at opacity a over the frame = every pixel moved a of the way to black.
        # On limited-range YUV that is a table lookup (luma towards 16, chroma towards 128), which costs
        # next to nothing per frame. (drawbox would blend the chroma of yuv420p four times over, and a
        # full-frame rectangle in libass cost more than all the captions of a clip.)
        def lut(a: float) -> tuple[str, str]:
            k = _f(1.0 - a)
            return f"16+(val-16)*{k}", f"128+(val-128)*{k}"

        last = dim[-1][0]
        lines = []
        for n, alpha in dim[1:-1]:
            y, c = lut(alpha)
            lines.append(f"{max(0.0, (n - 0.5) / FPS):.5f} lutyuv@dim y '{y}', lutyuv@dim u '{c}', lutyuv@dim v '{c}';")
        b.files["dim.cmd"] = "\n".join(lines) + "\n"
        y0, c0 = lut(dim[0][1])
        chain.append(f"sendcmd=f=dim.cmd,lutyuv@dim=y='{y0}':u='{c0}':v='{c0}':enable='lt(n,{last})'")
    if ass_file and shaping:
        # The subtitles filter always runs libass with its simple shaper, which leaves a gap after every
        # lam-alef and knows no contextual forms; the ass filter can be told to shape with HarfBuzz.
        chain.append(f"ass=filename={ass_file}:fontsdir={fonts_dir}:shaping=complex")
    elif ass_file:
        chain.append(f"subtitles=filename={ass_file}:fontsdir={fonts_dir}")
    if chain:
        b.parts.append(f"[{cur}]" + ",".join(chain) + "[fx]")
        cur = "fx"
    bar = edit.get("progressBar") or {}
    if bar.get("enabled"):
        bar_color = parse_color(str(bar.get("color") or "#FFE600")) or Color(255, 230, 0)
        if bar_color.a > 0:
            h = max(2, int(round(float(bar.get("height") or 10))))
            y = "0" if bar.get("position") == "top" else f"H-{h}"
            b.parts.append(f"color=c={bar_color.ffmpeg()}:s={m.OUT_W}x{h}:r={FPS},format=yuv420p[bar]")
            # ProgressBar: width = (frame + 1) / totalFrames of the frame
            b.parts.append(f"[{cur}][bar]overlay=x='-w+W*min(1,(n+1)/{total})':y={y}:shortest=1[pb]")
            cur = "pb"
    b.parts.append(f"[{cur}]format=yuv420p,setsar=1[outv]")

    if has_audio:
        acur = a_labels[0]
        if len(a_labels) > 1:
            b.parts.append("".join(f"[{x}]" for x in a_labels) + f"concat=n={len(a_labels)}:v=0:a=1[ca]")
            acur = "ca"
        vol = 1.0 if own_levels else float(edit.get("volume") if edit.get("volume") is not None else 1)
        b.parts.append(f"[{acur}]volume={_f(max(0.0, vol))}[outa]")
    else:
        b.parts.append(f"anullsrc=r=48000:cl=stereo,atrim=end={_f(total / FPS)}[outa]")

    return Plan(inputs=inputs, graph=";\n".join(b.parts) + "\n", files=b.files, total_frames=total)
