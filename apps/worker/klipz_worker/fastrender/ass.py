"""Captions and the hook card as an ASS script, drawn by libass inside FFmpeg.

The Remotion renderer decides per output frame which caption page is on screen, which word is being
spoken and how far the entrance animation is. This module makes the same decision for every frame with
the ported functions in model.py, merges consecutive frames that look the same, and writes one ASS event
per word (and per box / glow) with an absolute position. Nothing is left to libass's own layout, so the
result does not depend on its line breaking or spacing rules.

Layers (bottom to top): hook dim 0, hook shadow 1, hook card 2, hook text 3,
caption page background 10, caption glows / extra shadows 11, active-word box 12, caption text 13.

Text the caption font has every character for is written as before: one font, measured letter by letter,
drawn by libass's simple shaper. Text that needs the fallback font (Arabic script: Persian, Arabic, Urdu)
makes the whole script "shaped": words are split into runs per font, measured with HarfBuzz, ordered
right to left by bidi.py and drawn by libass's HarfBuzz shaper (see Script.shaped and graph.build_plan).
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Any, Optional, Sequence

from . import bidi
from . import model as m
from .text import RLM, Color, Font, Shadow, ShaperUnavailable, fallback_font, font, parse_color, parse_shadows, shaped_width, split_runs


class Unsupported(Exception):
    """The edit uses something the fast renderer does not draw; the caller falls back to Remotion."""


HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: D,Arial,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def frame_time(frame: int, fps: int = m.OUT_FPS) -> str:
    """ASS timestamp (centiseconds) of the boundary before `frame`: every earlier frame is before it and
    `frame` itself is at or after it, so events tile exactly on frame boundaries."""
    cs = (frame * 100) // fps
    h, rem = divmod(cs, 360000)
    mi, rem = divmod(rem, 6000)
    s, c = divmod(rem, 100)
    return f"{h}:{mi:02d}:{s:02d}.{c:02d}"


def _n(x: float) -> str:
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def clean_text(s: str) -> str:
    """Text that cannot be read as ASS override codes."""
    return s.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ").replace("\r", " ")


def rounded_rect(cx: float, cy: float, w: float, h: float, r: float) -> str:
    """ASS drawing commands for a rounded rectangle centred on (cx, cy)."""
    x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
    r = max(0.0, min(r, w / 2, h / 2))
    if r < 0.25:
        return f"m {_n(x0)} {_n(y0)} l {_n(x1)} {_n(y0)} {_n(x1)} {_n(y1)} {_n(x0)} {_n(y1)}"
    k = r * 0.5523
    p = _n
    return (
        f"m {p(x0 + r)} {p(y0)} l {p(x1 - r)} {p(y0)} "
        f"b {p(x1 - r + k)} {p(y0)} {p(x1)} {p(y0 + r - k)} {p(x1)} {p(y0 + r)} "
        f"l {p(x1)} {p(y1 - r)} "
        f"b {p(x1)} {p(y1 - r + k)} {p(x1 - r + k)} {p(y1)} {p(x1 - r)} {p(y1)} "
        f"l {p(x0 + r)} {p(y1)} "
        f"b {p(x0 + r - k)} {p(y1)} {p(x0)} {p(y1 - r + k)} {p(x0)} {p(y1 - r)} "
        f"l {p(x0)} {p(y0 + r)} "
        f"b {p(x0)} {p(y0 + r - k)} {p(x0 + r - k)} {p(y0)} {p(x0 + r)} {p(y0)}"
    )


@dataclass(frozen=True)
class Label:
    """One piece of text as it is drawn: a caption word or a line of the hook card."""
    text: str
    width: float                                            # px at the size it was measured for
    runs: Optional[tuple[tuple[Font, str], ...]] = None     # per font, in reading order; None = unshaped
    rtl: bool = False                                       # drawn right to left (shaped scripts only)
    spacing_em: float = 0.0                                 # letter-spacing it is drawn with


class Script:
    def __init__(self) -> None:
        self.events: list[str] = []
        # True when some text needs the fallback font: every label is then measured with HarfBuzz and the
        # script must be drawn by libass's HarfBuzz shaper with kerning on (as Chrome draws it).
        self.shaped = False

    def _add(self, layer: int, f0: int, f1: int, text: str) -> None:
        if f1 > f0:
            self.events.append(f"Dialogue: {layer},{frame_time(f0)},{frame_time(f1)},D,,0,0,0,,{text}")

    def rect(self, layer: int, f0: int, f1: int, cx: float, cy: float, w: float, h: float, r: float, color: Color,
             opacity: float = 1.0, blur: float = 0.0) -> None:
        if color.a * opacity <= 0.002 or w <= 0 or h <= 0:
            return
        tags = f"\\an7\\pos(0,0)\\bord0\\shad0\\1c{color.ass()}\\1a{color.ass_alpha(opacity)}"
        if blur > 0:
            tags += f"\\blur{_n(blur)}"
        self._add(layer, f0, f1, f"{{{tags}\\p1}}{rounded_rect(cx, cy, w, h, r)}{{\\p0}}")

    def text(self, layer: int, f0: int, f1: int, fnt: Font, label: Label, cx: float, cy: float, em: float, fill: Color,
             opacity: float = 1.0, *, spacing: float = 0.0, border: float = 0.0, border_color: Optional[Color] = None,
             shadow: Optional[Shadow] = None, shadow_scale: float = 1.0, blur: float = 0.0) -> None:
        """`fnt` is the caption font: it sets the baseline, also for runs drawn in the fallback font."""
        if not label.text or em <= 0.5:
            return
        if label.runs is None:
            first, y, direction, body = fnt, cy + fnt.center_shift(em), "", clean_text(label.text)
        else:
            # CSS puts the baseline where the caption font's line box has it, whatever font the glyphs
            # come from; libass centres (\an5) the tallest ascent + descent of the fonts in the event.
            fonts = [f for f, _ in label.runs]
            asc = max(f.win_ascent / f.upm for f in fonts)
            desc = max(f.win_descent / f.upm for f in fonts)
            first, y = fonts[0], cy + ((fnt.hhea_ascent + fnt.hhea_descent) / fnt.upm - (asc - desc)) / 2 * em
            body = "".join((f"{{\\fn{f.ass_family}\\fs{_n(f.ass_size(em))}}}" if i else "") + clean_text(t)
                           for i, (f, t) in enumerate(label.runs))
            # \fe-1 lets libass take the direction from the first strong character: the mark makes it RTL
            direction = "\\fe-1" if label.rtl else ""
            if label.rtl:
                body = RLM + body
        tags = (
            f"\\an5\\pos({_n(cx)},{_n(y)}){direction}\\fn{first.ass_family}\\fs{_n(first.ass_size(em))}\\b0\\i0"
            f"\\fsp{_n(spacing)}\\1c{fill.ass()}\\1a{fill.ass_alpha(opacity)}\\bord{_n(border)}"
        )
        if border > 0 and border_color is not None:
            tags += f"\\3c{border_color.ass()}\\3a{border_color.ass_alpha(opacity)}"
        if shadow is not None:
            tags += (f"\\xshad{_n(shadow.dx * shadow_scale)}\\yshad{_n(shadow.dy * shadow_scale)}"
                     f"\\4c{shadow.color.ass()}\\4a{shadow.color.ass_alpha(opacity)}")
        else:
            tags += "\\shad0"
        if blur > 0:
            tags += f"\\blur{_n(blur)}"
        self._add(layer, f0, f1, f"{{{tags}}}{body}")

    def render(self) -> str:
        head = HEADER.replace("WrapStyle: 2\n", "WrapStyle: 2\nKerning: yes\n") if self.shaped else HEADER
        return head + "\n".join(self.events) + "\n"


def fit_scale(measured: float, max_w: float) -> float:
    if not (measured > 0) or not (max_w > 0):
        return 1.0
    return min(1.0, max_w / measured)


def _color(value: str, what: str) -> Color:
    c = parse_color(value)
    if c is None:
        raise Unsupported(f"{what} '{value}' is not a plain colour")
    return c


def _needs_fallback(family: str, texts: Sequence[str]) -> bool:
    """True when `texts` have characters the font lacks and the fallback font has."""
    f, fb = font(family), fallback_font()
    if f is None or fb is None:
        return False
    return any(fb.has(c) for t in texts for c in f.missing(t))


def _need_font(family: str, texts: Sequence[str], shaped: bool) -> Font:
    f = font(family)
    if f is None:
        raise Unsupported(f"font '{family}' is not bundled with the fast renderer")
    fb = fallback_font()
    missing: set[str] = set()
    for t in texts:
        missing |= split_runs(t, f, fb)[1] if shaped else f.missing(t)
    if missing:
        sample = "".join(sorted(missing))[:8]
        also = f" or its fallback {fb.family}" if fb is not None else ""
        raise Unsupported(f"characters not in the caption font {family}{also}: {sample}")
    return f


def _label(text: str, fnt: Font, size: float, letter_spacing: float, shaped: bool) -> Label:
    """Measure `text` at `size` px per em. Unshaped: letter by letter in the caption font (as measureText
    does for Latin). Shaped: per font run with HarfBuzz; joined scripts get no letter-spacing."""
    if not shaped:
        return Label(text, fnt.width(text, size, letter_spacing), None, False, letter_spacing)
    fb = fallback_font()
    runs = tuple(split_runs(text, fnt, fb)[0])
    ls = 0.0 if bidi.has_cursive_script(text) else letter_spacing
    try:
        width = shaped_width(runs, size, fb, ligatures=ls == 0)
    except ShaperUnavailable as e:
        raise Unsupported(f"captions in Arabic script need a package that is missing: {e}") from e
    return Label(text, width + ls * size * m._js_len(text), runs, False, ls)


# ── captions ──────────────────────────────────────────────────────────────
@dataclass
class _PageLayout:
    page: m.CaptionPage
    labels: list[Label]              # display text per word (page order)
    widths: list[float]              # px at style fontSize
    rel: list[tuple[float, float]]   # word centre relative to the block centre, unscaled
    n_lines: int
    widest: float
    scale_fit: float
    pos: float
    appear_frame: int


def _display(w: dict[str, Any], style: dict[str, Any]) -> str:
    return w["w"].upper() if style.get("uppercase") else w["w"]


def _layout_pages(pages: Sequence[m.CaptionPage], style: dict[str, Any], fnt: Font, safe_zone: str, shaped: bool,
                  base: str) -> list[_PageLayout]:
    size, ls = float(style["fontSize"]), float(style["letterSpacing"])
    gap = size * 0.28
    pad = float(style["pagePadding"])
    line_h = size * float(style["lineHeight"])
    max_w = m.max_caption_width(safe_zone)
    zone = m.SAFE_ZONES.get(safe_zone) if safe_zone != "none" else None
    out: list[_PageLayout] = []
    for page in pages:
        if style.get("emoji") and any(w.get("emoji") for w in page.words):
            raise Unsupported("emoji captions are drawn by the Studio renderer only")
        lines = m.layout_lines(page.words, int(style["maxCharsPerLine"]))
        label = {id(w): _label(_display(w, style), fnt, size, ls, shaped) for w in page.words}
        width = {id(w): label[id(w)].width for w in page.words}
        rel: dict[int, tuple[float, float]] = {}
        widest = 0.0
        for li, line in enumerate(lines):
            lw = sum(width[id(w)] for w in line) + gap * (len(line) - 1)
            widest = max(widest, lw)
            x = -lw / 2
            # left to right on screen: the reading order for Latin, reversed for a right-to-left line
            dirs = bidi.resolve_word_directions([w["w"] for w in line], base)
            for i in bidi.visual_order(dirs, base):
                w = line[i]
                rel[id(w)] = (x + width[id(w)] / 2, (li - (len(lines) - 1) / 2) * line_h)
                x += width[id(w)] + gap
                if dirs[i] == bidi.RTL and shaped:
                    label[id(w)] = dataclasses.replace(label[id(w)], rtl=True)
        scale_fit = fit_scale(widest + pad * 2, max_w)
        block_frac = (len(lines) * line_h + pad * 2) / m.OUT_H
        out.append(_PageLayout(
            page=page, labels=[label[id(w)] for w in page.words], widths=[width[id(w)] for w in page.words],
            rel=[rel[id(w)] for w in page.words], n_lines=len(lines), widest=widest, scale_fit=scale_fit,
            pos=m.clamp_to_safe_zone(float(style["position"]), zone, block_frac * scale_fit),
            appear_frame=m.js_round(page.start * m.OUT_FPS),
        ))
    return out


def _emit_caption(script: Script, lay: _PageLayout, active: int, anim_frame: int, f0: int, f1: int, style: dict[str, Any],
                  fnt: Font, colors: dict[str, Color], shadows: list[Shadow]) -> None:
    e = m.entrance(style["anim"], anim_frame)
    if e.opacity <= 0.002:
        return
    size = float(style["fontSize"])
    pad = float(style["pagePadding"])
    line_h = size * float(style["lineHeight"])
    s_block = lay.scale_fit * e.scale
    cx0, cy0 = m.OUT_W / 2, lay.pos * m.OUT_H + e.translate_y
    if colors["page"].a > 0:
        radius = max(12.0, float(style["boxRadius"])) if pad > 0 else 0.0
        script.rect(10, f0, f1, cx0, cy0, (lay.widest + pad * 2) * s_block, (lay.n_lines * line_h + pad * 2) * s_block,
                    radius * s_block, colors["page"], e.opacity)
    highlight = style["highlight"]
    stroke = float(style["strokeWidth"])
    hard = [s for s in shadows if s.blur <= 0]
    glows = [s for s in shadows if s.blur > 0]
    for i, w in enumerate(lay.page.words):
        is_active, spoken = i == active, i <= active
        fill, word_scale, boxed = colors["color"], 1.0, False
        if highlight == "color" and is_active:
            fill = colors["active"]
        elif highlight == "karaoke" and spoken:
            fill = colors["active"]
        elif highlight == "box" and is_active:
            fill, boxed = colors["active"], True
        elif highlight == "scale" and is_active:
            fill, word_scale = colors["active"], 1.18
        if w.get("emph") and not (highlight == "box" and is_active):
            fill = colors["emphasis"]
        k = s_block * word_scale
        wx, wy = cx0 + lay.rel[i][0] * s_block, cy0 + lay.rel[i][1] * s_block
        em = size * k
        border = stroke / 2 * k
        spacing = lay.labels[i].spacing_em * size * k
        if boxed:
            script.rect(12, f0, f1, wx, wy, (lay.widths[i] + 2 * 0.12 * size) * s_block, line_h * s_block,
                        float(style["boxRadius"]) * s_block, colors["box"], e.opacity)
        # CSS paints the first listed shadow on top, so draw the list back to front
        for sh in reversed(glows):
            script.text(11, f0, f1, fnt, lay.labels[i], wx + sh.dx * k, wy + sh.dy * k, em, sh.color, e.opacity, spacing=spacing,
                        border=border, border_color=sh.color, blur=sh.blur / 2 * k)
        for sh in reversed(hard[1:]):
            script.text(11, f0, f1, fnt, lay.labels[i], wx + sh.dx * k, wy + sh.dy * k, em, sh.color, e.opacity, spacing=spacing,
                        border=border, border_color=sh.color)
        script.text(13, f0, f1, fnt, lay.labels[i], wx, wy, em, fill, e.opacity, spacing=spacing, border=border,
                    border_color=colors["stroke"], shadow=hard[0] if hard else None, shadow_scale=k)


def _caption_setup(edit: dict[str, Any], custom_styles: Sequence[dict[str, Any]]) -> Optional[tuple[dict[str, Any], list[dict[str, Any]]]]:
    """(style, words on the timeline) when the edit shows captions."""
    cap = edit.get("captions") or {}
    if not cap.get("enabled"):
        return None
    style = m.resolve_caption_style(cap.get("styleId") or "", cap.get("overrides") or {}, custom_styles)
    words = m.caption_words_on_timeline(edit["video"], cap.get("words") or [])
    return (style, words) if words else None


def add_captions(script: Script, edit: dict[str, Any], custom_styles: Sequence[dict[str, Any]], total_frames: int) -> None:
    setup = _caption_setup(edit, custom_styles)
    if setup is None:
        return
    style, words = setup
    pages = m.paginate(words, style)
    shadows = parse_shadows(str(style.get("shadow") or "none"))
    if shadows is None:
        raise Unsupported(f"caption shadow '{style.get('shadow')}' is not understood")
    colors = {
        "color": _color(style["color"], "caption colour"), "active": _color(style["activeColor"], "caption active colour"),
        "emphasis": _color(style["emphasisColor"], "caption emphasis colour"), "box": _color(style["boxColor"], "caption box colour"),
        "stroke": _color(style["strokeColor"], "caption outline colour"), "page": _color(style["pageBackground"], "caption background"),
    }
    fnt = _need_font(str(style["fontFamily"]), [_display(w, style) for w in words], script.shaped)
    # one reading direction for the whole clip, as in Captions.tsx
    base = bidi.base_direction(w["w"] for w in words)
    layouts = _layout_pages(pages, style, fnt, str(edit.get("safeZone") or "none"), script.shaped, base)
    anim = str(style.get("anim") or "none")

    def state_at(n: int) -> Optional[tuple[int, int, int]]:
        t = n / m.OUT_FPS
        pi = m.page_at(pages, t)
        if pi is None:
            return None
        af = max(0, n - layouts[pi].appear_frame)
        settle = m.settle_frame(anim)
        return pi, m.active_word_index(pages[pi], t), min(af, settle)

    prev: Optional[tuple[int, int, int]] = None
    start = 0
    for n in range(total_frames + 1):
        cur = state_at(n) if n < total_frames else None
        if n == total_frames or cur != prev:
            if prev is not None:
                _emit_caption(script, layouts[prev[0]], prev[1], prev[2], start, n, style, fnt, colors, shadows)
            prev, start = cur, n


# ── hook card ─────────────────────────────────────────────────────────────
HOOK_DIM = Color(0, 0, 0, 0.38)
HOOK_SHADOW = Color(0, 0, 0, 0.5)


def hook_lines(text: str, uppercase: bool = True) -> list[str]:
    lines: list[str] = []
    cur = ""
    for word in (text.strip().upper() if uppercase else text.strip()).split():
        if cur and len(cur) + 1 + len(word) > 14:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}" if cur else word
    if cur:
        lines.append(cur)
    return lines


def hook_dim(edit: dict[str, Any], total_frames: int) -> list[tuple[int, float]]:
    """The dim behind the hook card as (frame, opacity) change points; the last entry is where it ends.
    Empty when there is no hook. libass can draw it too (add_hook(draw_dim=True)), but a full-frame
    rectangle redrawn every frame cost more than all the captions of a clip together, so the filter graph
    draws it with drawbox instead (graph.build_plan(dim=...))."""
    hook = edit.get("hook") or {}
    if not hook.get("enabled") or not str(hook.get("text") or "").strip():
        return []
    dur_f = m.js_round(float(hook.get("durationSec") or 0) * m.OUT_FPS)
    last = min(dur_f, total_frames)
    if last <= 0:
        return []
    out: list[tuple[int, float]] = []
    for n in range(last):
        a = round(HOOK_DIM.a * m.hook_envelope(n, dur_f), 3)
        if not out or out[-1][1] != a:
            out.append((n, a))
    out.append((last, 0.0))
    return out


@dataclass(frozen=True)
class _HookLook:
    """The hook card's resolved style (model.resolve_hook_style), checked and converted for drawing."""
    family: str
    size: float
    uppercase: bool
    color: Color
    background: Optional[Color]      # None = no card (text alone, no shadow)
    stroke: float                    # CSS outline width in px
    stroke_color: Color


def _hook_look(edit: dict[str, Any]) -> _HookLook:
    """Raises Unsupported for a style the fast renderer cannot draw the way the Studio renderer does."""
    style = m.resolve_hook_style(edit.get("hook"))
    family = str(style.get("fontFamily") or "")
    try:
        size, stroke = float(style.get("fontSize")), float(style.get("strokeWidth") or 0)
    except (TypeError, ValueError) as e:
        raise Unsupported(f"hook card size '{style.get('fontSize')}' is not a number") from e
    if not (8 <= size <= 400) or not (0 <= stroke <= 60):
        raise Unsupported(f"hook card size {size:g} px / outline {stroke:g} px is out of range for the fast renderer")
    bg_value = str(style.get("background") or "").strip()
    bg = None if bg_value.lower() in ("", "none", "transparent") else _color(bg_value, "hook card background")
    return _HookLook(
        family=family, size=size, uppercase=bool(style.get("uppercase", True)),
        color=_color(str(style.get("color") or ""), "hook text colour"),
        background=bg if bg is not None and bg.a > 0 else None,
        stroke=stroke,
        stroke_color=_color(str(style.get("strokeColor") or "#000000"), "hook outline colour") if stroke > 0 else Color(0, 0, 0),
    )


def _hook_text(edit: dict[str, Any]) -> Optional[str]:
    hook = edit.get("hook") or {}
    text = str(hook.get("text") or "")
    return text if hook.get("enabled") and text.strip() else None


def add_hook(script: Script, edit: dict[str, Any], total_frames: int, draw_dim: bool = True) -> None:
    text = _hook_text(edit)
    if text is None:
        return
    dur_f = m.js_round(float((edit.get("hook") or {}).get("durationSec") or 0) * m.OUT_FPS)
    if dur_f <= 0:
        return
    look = _hook_look(edit)
    texts = hook_lines(text, look.uppercase)
    fnt = _need_font(look.family, texts, script.shaped)
    # a line is one event: libass orders its words, right to left when most of the hook's letters are
    rtl = script.shaped and bidi.base_direction([text]) == bidi.RTL
    lines = [dataclasses.replace(_label(l, fnt, look.size, 0.0, script.shaped), rtl=rtl) for l in texts]
    widest = max(l.width for l in lines)
    # padding (28 / 40), corners (32) and shadow were made for the 92 px card and scale with the text
    u = look.size / m.HOOK_BASE_SIZE
    safe_zone = str(edit.get("safeZone") or "none")
    fit = fit_scale(widest + 80 * u, m.max_caption_width(safe_zone))
    zone = m.SAFE_ZONES.get(safe_zone) if safe_zone != "none" else None
    cy = m.clamp_to_safe_zone(0.3, zone, 0.2) * m.OUT_H
    cx = m.OUT_W / 2
    line_h = look.size * 1.1
    card_w, card_h = widest + 2 * 40 * u, len(lines) * line_h + 2 * 28 * u

    def state_at(n: int) -> tuple[float, float]:
        env = m.hook_envelope(n, dur_f)
        spring = m.entrance("bounce", min(n, dur_f - n)).scale
        return round(env, 4), round(fit * (0.85 + 0.15 * spring), 5)

    last = min(dur_f, total_frames)
    prev: Optional[tuple[float, float]] = None
    start = 0
    for n in range(last + 1):
        cur = state_at(n) if n < last else None
        if n == last or cur != prev:
            if prev is not None and prev[0] > 0.002:
                env, k = prev
                if draw_dim:
                    script.rect(0, start, n, cx, m.OUT_H / 2, m.OUT_W, m.OUT_H, 0, HOOK_DIM, env)
                if look.background is not None:
                    script.rect(1, start, n, cx, cy + 10 * u * k, card_w * k, card_h * k, 32 * u * k, HOOK_SHADOW, env, blur=20 * u * k)
                    script.rect(2, start, n, cx, cy, card_w * k, card_h * k, 32 * u * k, look.background, env)
                for i, line in enumerate(lines):
                    script.text(3, start, n, fnt, line, cx, cy + (i - (len(lines) - 1) / 2) * line_h * k, look.size * k, look.color, env,
                                border=look.stroke / 2 * k, border_color=look.stroke_color if look.stroke > 0 else None)
            prev, start = cur, n


def build_script(edit: dict[str, Any], custom_styles: Sequence[dict[str, Any]], total_frames: int, draw_dim: bool = True) -> Optional[Script]:
    """The ASS script for this edit, or None when there is nothing to draw. Raises Unsupported.
    `draw_dim=False` leaves the hook's full-frame dim to the filter graph (see hook_dim)."""
    script = Script()
    # Decided for the whole script first: one file is drawn by one shaper, so when any text needs the
    # fallback font, every text is measured the way that shaper sets it.
    text = _hook_text(edit)
    look = _hook_look(edit) if text is not None else None
    setup = _caption_setup(edit, custom_styles)
    script.shaped = bool(
        (look is not None and _needs_fallback(look.family, hook_lines(text, look.uppercase)))
        or (setup is not None and _needs_fallback(str(setup[0].get("fontFamily")), [_display(w, setup[0]) for w in setup[1]]))
    )
    # glyphs first: text no bundled font has is the reason to give, before anything is measured
    if look is not None:
        _need_font(look.family, hook_lines(text, look.uppercase), script.shaped)
    if setup is not None:
        _need_font(str(setup[0]["fontFamily"]), [_display(w, setup[0]) for w in setup[1]], script.shaped)
    add_hook(script, edit, total_frames, draw_dim)
    add_captions(script, edit, custom_styles, total_frames)
    return script if script.events else None


def build_ass(edit: dict[str, Any], custom_styles: Sequence[dict[str, Any]], total_frames: int, draw_dim: bool = True) -> Optional[str]:
    """build_script() as text."""
    script = build_script(edit, custom_styles, total_frames, draw_dim)
    return script.render() if script is not None else None
