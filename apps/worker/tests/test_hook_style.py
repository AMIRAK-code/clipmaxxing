"""Hook card text styles in the fast renderer: same presets and overrides as the Studio renderer
(packages/video/src/Overlays.tsx hookCardLayout), Studio fallback for what it cannot draw."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from klipz_worker import fastrender, ffmpeg
from klipz_worker.fastrender import ass
from klipz_worker.fastrender import model as m
from klipz_worker.fastrender.text import Color

from .test_fastrender import _probe_frames, props_for


def hook_edit(style_id: str | None = None, overrides: dict | None = None, text: str = "Why does this work?") -> dict:
    edit = {
        "version": 1,
        "video": [{"id": "v", "srcStart": 0.5, "srcEnd": 6.0}],
        "captions": {"enabled": False, "styleId": "bold-outline", "overrides": {}, "words": []},
        "broll": [], "audio": [], "texts": [], "zooms": [], "look": "none",
        "hook": {"enabled": True, "text": text, "durationSec": 3},
        "progressBar": {"enabled": False, "color": "#FFE600", "position": "bottom", "height": 10},
        "volume": 1, "duckLevel": 0.25, "safeZone": "tiktok",
    }
    if style_id is not None:
        edit["hook"]["styleId"] = style_id
    if overrides is not None:
        edit["hook"]["overrides"] = overrides
    return edit


def events(edit: dict, layer: int) -> list[str]:
    script = ass.build_ass(edit, [], m.duration_in_frames(edit["video"]))
    assert script is not None
    return [ln for ln in script.splitlines() if ln.startswith(f"Dialogue: {layer},")]


def test_presets_match_the_typescript_ones():
    data = json.loads((Path(m.__file__).with_name("presets.json")).read_text(encoding="utf-8"))
    assert [p["id"] for p in data["hookPresets"]] == [p["id"] for p in m.HOOK_PRESETS]
    assert m.HOOK_PRESETS[0]["id"] == "purple-card" and m.HOOK_BASE_SIZE == 92
    assert m.resolve_hook_style(None) == m.HOOK_PRESETS[0]
    assert m.resolve_hook_style({"styleId": "gone", "overrides": {"color": "#000"}})["color"] == "#000"
    for p in m.HOOK_PRESETS:
        assert p["fontFamily"] in m.FONT_FILES, p["id"]


def test_unstyled_hook_is_the_original_purple_card():
    edit = hook_edit()
    card = events(edit, 2)
    text = events(edit, 3)
    assert card and text and events(edit, 1)  # card, its text and its shadow
    assert all(Color(124, 58, 237).ass() in e for e in card)
    assert all("\\fnKLIPZ Montserrat" in e and "\\1c&HFFFFFF&" in e and "\\bord0" in e for e in text)
    assert "WHY DOES THIS" in text[0]


def test_styled_hook_uses_font_colours_size_and_outline():
    edit = hook_edit("yellow-box", {"fontFamily": "Bebas Neue", "color": "#FF0000", "fontSize": 46,
                                    "strokeWidth": 8, "strokeColor": "#00FF00", "uppercase": False})
    card, text = events(edit, 2), events(edit, 3)
    assert all(Color(255, 214, 10).ass() in e for e in card)
    assert all("\\fnKLIPZ Bebas Neue" in e and "\\1c&H0000FF&" in e and "\\3c&H00FF00&" in e for e in text)
    assert "Why does this" in text[0]  # uppercase off
    # settled frame (k = 1): outline is half the CSS stroke, size is the chosen size, corners scale with it
    assert any("\\bord4\\" in e and "\\fs" in e for e in text), text[:3]
    assert not any("\\blur" in e for e in card)  # only the shadow is blurred
    # once the bounce settles (k = 1) the shadow's blur is 20 px scaled by size / 92
    blurs = [float(x) for e in events(edit, 1) for x in re.findall(r"\\blur([\d.]+)", e)]
    assert any(b == pytest.approx(20 * 46 / 92, abs=0.02) for b in blurs), blurs


def test_text_alone_has_no_card_and_no_shadow():
    edit = hook_edit("outline")
    assert events(edit, 1) == [] and events(edit, 2) == []
    text = events(edit, 3)
    assert text and all("\\fnKLIPZ Anton" in e and "\\3c&H000000&" in e for e in text)
    assert fastrender.unsupported_reason(props_for(edit)) is None


@pytest.mark.parametrize("preset", [p["id"] for p in m.HOOK_PRESETS])
def test_every_hook_preset_is_drawn_by_the_fast_renderer(preset: str):
    assert fastrender.unsupported_reason(props_for(hook_edit(preset))) is None


@pytest.mark.parametrize("overrides, why", [
    ({"background": "linear-gradient(#f00, #00f)"}, "hook card background"),
    ({"color": "var(--accent)"}, "hook text colour"),
    ({"strokeWidth": 4, "strokeColor": "hsl(0 0% 0%)"}, "hook outline colour"),
    ({"fontFamily": "Comic Sans MS"}, "not bundled"),
    ({"fontSize": "big"}, "not a number"),
    ({"fontSize": 2000}, "out of range"),
])
def test_styles_it_cannot_draw_go_to_the_studio_renderer(overrides: dict, why: str):
    reason = fastrender.unsupported_reason(props_for(hook_edit("purple-card", overrides)))
    assert reason and why in reason, reason


def test_a_disabled_hook_never_blocks_the_fast_renderer():
    edit = hook_edit("purple-card", {"fontFamily": "Comic Sans MS"})
    edit["hook"]["enabled"] = False
    assert fastrender.unsupported_reason(props_for(edit)) is None


def test_persian_hook_in_another_font_is_shaped_with_the_fallback():
    pytest.importorskip("uharfbuzz")
    edit = hook_edit("clean-white", text="چرا هیچکس این را نمی‌گوید")
    script = ass.build_script(edit, [], m.duration_in_frames(edit["video"]))
    assert script is not None and script.shaped
    text = [e for e in script.events if e.startswith("Dialogue: 3,")]
    assert text and all("KLIPZ Vazirmatn" in e and "\\fe-1" in e for e in text)


def test_render_styled_hook(tmp_path: Path, sample_video: Path):
    edit = hook_edit("red-alert", {"strokeWidth": 6})
    props = props_for(edit)
    out = tmp_path / "hook.mp4"
    ff, fp = ffmpeg.binaries()
    info = fastrender.render(props, sample_video, out, tmp_path / "work", ffmpeg=ff, ffprobe=fp, has_audio=True)
    assert _probe_frames(out) == info["frames"] == m.duration_in_frames(edit["video"])
    assert "KLIPZ Bebas Neue" in (tmp_path / "work" / "captions.ass").read_text(encoding="utf-8")
