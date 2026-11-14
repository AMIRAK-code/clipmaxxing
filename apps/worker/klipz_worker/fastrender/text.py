"""Fonts, text measuring and CSS value parsing for the fast renderer."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

FONT_DIR = Path(__file__).with_name("fonts")
_FONTS = json.loads(Path(__file__).with_name("fonts.json").read_text(encoding="utf-8"))


@dataclass(frozen=True)
class Font:
    family: str          # CSS family, e.g. "Montserrat"
    ass_family: str      # name inside the TTF that libass matches, e.g. "KLIPZ Montserrat"
    file: str
    upm: int
    hhea_ascent: int
    hhea_descent: int    # negative
    win_ascent: int
    win_descent: int     # positive
    advances: dict[int, int]

    def has(self, ch: str) -> bool:
        return ord(ch) in self.advances

    def missing(self, text: str) -> set[str]:
        return {c for c in text if not c.isspace() and ord(c) not in self.advances}

    def width(self, text: str, size: float, letter_spacing_em: float = 0.0) -> float:
        """Advance width in px at `size` px per em. Mirrors measureText() + letter-spacing in fit.ts."""
        units = sum(self.advances.get(ord(c), self.upm * 0.6) for c in text)
        js_length = len(text.encode("utf-16-le")) // 2  # String.length, as the TS counts characters
        return units * size / self.upm + letter_spacing_em * size * js_length

    def ass_size(self, css_px: float) -> float:
        """ASS \\fs that gives `css_px` px per em: libass sizes a font by its OS/2 win ascent + descent."""
        return css_px * (self.win_ascent + self.win_descent) / self.upm

    def center_shift(self, css_px: float) -> float:
        """How far below the CSS line centre libass must be told to centre the text (\\an5) so the
        baselines coincide. CSS centres the hhea content area, libass the win ascent/descent box."""
        return ((self.hhea_ascent + self.hhea_descent) - (self.win_ascent - self.win_descent)) / 2 / self.upm * css_px


def font(family: str) -> Optional[Font]:
    f = _FONTS.get(family)
    if not f:
        return None
    return Font(family, f["assFamily"], f["file"], f["unitsPerEm"], f["hheaAscent"], f["hheaDescent"], f["winAscent"],
                f["winDescent"], {int(k): v for k, v in f["advances"].items()})


def font_files() -> list[Path]:
    return [FONT_DIR / f["file"] for f in _FONTS.values()]


# ── colours ───────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Color:
    r: int
    g: int
    b: int
    a: float = 1.0

    def ass(self) -> str:
        return f"&H{self.b:02X}{self.g:02X}{self.r:02X}&"

    def ass_alpha(self, opacity: float = 1.0) -> str:
        a = max(0.0, min(1.0, self.a * opacity))
        return f"&H{255 - int(round(a * 255)):02X}&"

    def ffmpeg(self) -> str:
        return f"0x{self.r:02X}{self.g:02X}{self.b:02X}"


_NAMED = {"white": (255, 255, 255), "black": (0, 0, 0), "red": (255, 0, 0), "yellow": (255, 255, 0)}
_RGB_RE = re.compile(r"^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+%?)\s*)?\)$", re.I)


def parse_color(value: str) -> Optional[Color]:
    """CSS colour -> Color; None when it is not a plain colour (gradients, variables ...)."""
    v = (value or "").strip()
    low = v.lower()
    if low == "transparent":
        return Color(0, 0, 0, 0.0)
    if low in _NAMED:
        return Color(*_NAMED[low])
    if v.startswith("#"):
        h = v[1:]
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        if len(h) in (6, 8) and re.fullmatch(r"[0-9a-fA-F]+", h):
            a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
            return Color(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)
        return None
    m = _RGB_RE.match(v)
    if m:
        a = m.group(4)
        alpha = 1.0 if a is None else (float(a[:-1]) / 100 if a.endswith("%") else float(a))
        return Color(*(max(0, min(255, int(round(float(m.group(i)))))) for i in (1, 2, 3)), max(0.0, min(1.0, alpha)))
    return None


@dataclass(frozen=True)
class Shadow:
    dx: float
    dy: float
    blur: float
    color: Color


def _split_top_level(s: str) -> list[str]:
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


_LEN_RE = re.compile(r"^-?\d*\.?\d+(px)?$")


def parse_shadows(value: str) -> Optional[list[Shadow]]:
    """CSS text-shadow list -> shadows in paint order (first listed is on top); None if unparsable."""
    v = (value or "").strip()
    if not v or v.lower() == "none":
        return []
    out: list[Shadow] = []
    for part in _split_top_level(v):
        tokens = re.findall(r"rgba?\([^)]*\)|#[0-9a-fA-F]+|[^\s]+", part)
        lengths = [t for t in tokens if _LEN_RE.match(t)]
        colors = [t for t in tokens if not _LEN_RE.match(t)]
        if len(lengths) not in (2, 3) or len(colors) > 1:
            return None
        color = parse_color(colors[0]) if colors else Color(0, 0, 0)
        if color is None:
            return None
        nums = [float(t[:-2] if t.endswith("px") else t) for t in lengths]
        out.append(Shadow(nums[0], nums[1], nums[2] if len(nums) == 3 else 0.0, color))
    return out
