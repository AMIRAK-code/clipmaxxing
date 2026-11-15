"""Fast (FFmpeg) renderer: the ported composition math, the ASS writer, the filter graph and real renders."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from klipz_worker import fastrender, ffmpeg
from klipz_worker.fastrender import ass, graph
from klipz_worker.fastrender import model as m
from klipz_worker.fastrender.text import font, font_files, parse_color, parse_shadows
from klipz_worker.steps import render as render_step
from klipz_worker.steps import smart_edit

from .conftest import add_source
from .test_analyze import make_ctx


def W(text: str, s: float, e: float) -> dict:
    return {"w": text, "s": s, "e": e}


WORDS = [W("Why", 1.0, 1.2), W("does", 1.25, 1.5), W("this", 1.55, 1.8), W("work?", 1.85, 2.3),
         W("Because", 3.6, 4.0), W("100", 4.05, 4.4), W("people", 4.45, 4.9), W("tried.", 4.95, 5.4)]


def edit_for(start: float = 0.5, end: float = 6.0, **kw) -> dict:
    return smart_edit.build_edit(WORDS, start, end, keywords=["people"], hook="Why does this work?", **kw)


def props_for(edit: dict, track: dict | None = None) -> dict:
    return {"sourceUrl": "sources/x/source.mp4", "srcW": 1280, "srcH": 720, "cropTrack": track, "assetBaseUrl": "", "edit": edit}


# ── model (ports of packages/shared and packages/video) ────────────────────
def test_js_round_and_piece_frames_tile_exactly():
    assert [m.js_round(x) for x in (0.5, 1.5, 2.5, -0.5, 2.4999)] == [1, 2, 3, 0, 2]
    pieces = [{"srcStart": 0.0, "srcEnd": 1.017}, {"srcStart": 3.0, "srcEnd": 3.983}, {"srcStart": 9.0, "srcEnd": 10.25}]
    frames = m.piece_frames(pieces)
    assert frames[0][0] == 0
    for (a0, an), (b0, _bn) in zip(frames, frames[1:]):
        assert a0 + an == b0  # no gap, no overlap
    assert sum(n for _f, n in frames) == m.duration_in_frames(pieces)


def test_zoom_at_matches_the_typescript_semantics():
    keys = [{"t": 0, "scale": 1.0, "ease": "linear"}, {"t": 2, "scale": 1.2, "ease": "snap"}, {"t": 4, "scale": 1.0, "ease": "ease"}]
    assert m.zoom_at([], 3) == 1.0
    assert m.zoom_at(keys, 1.99) == 1.0          # snap holds the previous scale until the key
    assert m.zoom_at(keys, 2.0) == pytest.approx(1.0)  # ... and the key itself still belongs to the hold
    assert m.zoom_at(keys, 3.0) == pytest.approx(1.1)  # smoothstep midpoint
    assert m.zoom_at(keys, 2.5) == pytest.approx(1.2 - 0.2 * (0.25 * 0.25 * (3 - 0.5)))
    assert m.zoom_at(keys, 99) == 1.0


def test_layout_at_crop_letterbox_split():
    track = {"segments": [
        {"start": 0, "end": 2, "layout": "crop", "keys": [{"t": 0, "cx": 0.25, "cy": 0.5}, {"t": 2, "cx": 0.75, "cy": 0.5}]},
        {"start": 2, "end": 4, "layout": "letterbox", "keys": []},
        {"start": 4, "end": 6, "layout": "split", "keys": [{"t": 4, "cx": 0.2, "cy": 0.5}], "keys2": [{"t": 4, "cx": 0.8, "cy": 0.5}]},
    ]}
    crop = m.layout_at(track, 1.0, 1280, 720)
    assert crop.layout == "crop" and crop.panes[0].src.w == pytest.approx(405) and crop.panes[0].src.h == 720
    assert crop.panes[0].src.x == pytest.approx(0.5 * 1280 - 202.5)
    box = m.layout_at(track, 3.0, 1280, 720)
    assert box.layout == "letterbox" and box.blurred_background and box.panes[0].dst.h == pytest.approx(607.5)
    split = m.layout_at(track, 5.0, 1280, 720)
    assert split.layout == "split" and len(split.panes) == 2 and split.panes[1].dst.y == 960
    assert m.layout_at(None, 0, 1280, 720).panes[0].src.x == pytest.approx((1280 - 405) / 2)  # no track: centre crop
    assert m.layout_at(track, 99, 1280, 720).layout == "split"  # past the end: nearest segment


def test_paginate_breaks_on_sentence_end_and_page_size():
    style = m.resolve_caption_style("bold-outline")
    words = m.caption_words_on_timeline([{"srcStart": 0.5, "srcEnd": 6.0}], WORDS)
    pages = m.paginate(words, style)
    assert [[w["w"] for w in p.words] for p in pages] == [["Why", "does", "this"], ["work?"], ["Because", "100", "people"], ["tried."]]
    assert all(a.end <= b.start + 1e-9 for a, b in zip(pages, pages[1:]))
    assert m.page_at(pages, pages[2].start) == 2 and m.page_at(pages, -1) is None
    assert m.active_word_index(pages[0], pages[0].words[1]["os"]) == 1


def test_entrance_curves_settle():
    for anim in ("pop", "bounce", "fade", "slide-up", "none"):
        end = m.entrance(anim, m.settle_frame(anim))
        later = m.entrance(anim, m.settle_frame(anim) + 30)
        assert end.opacity == pytest.approx(1.0) and later.scale == pytest.approx(end.scale, abs=1e-3)
        assert later.translate_y == pytest.approx(end.translate_y, abs=0.05)
    assert m.entrance("pop", 0).scale == pytest.approx(0.6)
    assert m.hook_envelope(0, 90) == 0 and m.hook_envelope(45, 90) == 1 and m.hook_envelope(90, 90) == 0


# ── text ───────────────────────────────────────────────────────────────────
def test_fonts_are_bundled_and_measure():
    for f in font_files():
        assert f.exists() and f.stat().st_size > 10_000, f
    mont = font("Montserrat")
    assert mont is not None and mont.width("AB", 100) > mont.width("A", 100) > 0
    assert mont.missing("Hello è 100%") == set() and "中" in mont.missing("中")
    assert font("Comic Sans") is None


def test_css_parsing():
    assert parse_color("#FFE600").ass() == "&H00E6FF&"
    assert parse_color("rgba(0,0,0,0.5)").a == 0.5 and parse_color("transparent").a == 0
    assert parse_color("linear-gradient(90deg,#fff,#000)") is None
    sh = parse_shadows("0 6px 0 rgba(0,0,0,0.55), 0 0 24px #7C3AED")
    assert [(s.dx, s.dy, s.blur) for s in sh] == [(0, 6, 0), (0, 0, 24)]
    assert parse_shadows("none") == [] and parse_shadows("inset 1px") is None


# ── ASS ────────────────────────────────────────────────────────────────────
def test_frame_time_tiles_on_frame_boundaries():
    assert ass.frame_time(0) == "0:00:00.00" and ass.frame_time(30) == "0:00:01.00" and ass.frame_time(1) == "0:00:00.03"
    assert ass.frame_time(30 * 3661) == "1:01:01.00"


def test_build_ass_draws_hook_and_every_caption_page():
    edit = edit_for()
    total = m.duration_in_frames(edit["video"])
    script = ass.build_ass(edit, [], total)
    assert script is not None and script.startswith("[Script Info]")
    events = [ln for ln in script.splitlines() if ln.startswith("Dialogue:")]
    text = "\n".join(events)
    for word in ("WHY", "DOES", "THIS", "WORK?", "BECAUSE", "100", "PEOPLE", "TRIED."):
        assert word in text
    assert "KLIPZ Montserrat" in text and "\\p1" in text            # caption font, hook card drawing
    assert "{" not in ass.clean_text("a{\\b1}b") and "\\" not in ass.clean_text("a\\Nb")
    off = {**edit, "captions": {**edit["captions"], "enabled": False}, "hook": {**edit["hook"], "enabled": False}}
    assert ass.build_ass(off, [], total) is None


def test_every_builtin_caption_style_is_drawn_or_refused_with_a_reason():
    for preset in m.CAPTION_PRESETS:
        edit = edit_for(style_id=preset["id"])
        reason = fastrender.unsupported_reason(props_for(edit))
        assert reason is None or isinstance(reason, str) and len(reason) > 10, preset["id"]
    assert fastrender.unsupported_reason(props_for(edit_for())) is None  # the default style is always fast


def test_unsupported_edits_fall_back_with_a_reason():
    base = edit_for()
    cases = {
        "look": {**base, "look": "warm"},
        "b-roll": {**base, "broll": [{"id": "b", "src": "x.mp4"}]},
        "audio": {**base, "audio": [{"id": "a", "src": "x.mp3"}]},
        "text": {**base, "texts": [{"id": "t", "text": "hi"}]},
        "transition": {**base, "video": [{**base["video"][0], "transitionIn": {"type": "fade", "durationSec": 0.3}}]},
    }
    for what, edit in cases.items():
        reason = fastrender.unsupported_reason(props_for(edit))
        assert reason and "Studio" in reason, what
    assert "no saved edit" in fastrender.unsupported_reason({**props_for(base), "edit": None})
    emoji = json.loads(json.dumps(base))
    emoji["captions"]["words"][0]["w"] = "\U0001F525"
    assert fastrender.unsupported_reason(props_for(emoji))  # a glyph the caption font does not have


# ── filter graph ───────────────────────────────────────────────────────────
def test_plan_groups_pieces_into_spans_and_counts_frames():
    edit = edit_for()
    plan = graph.build_plan(props_for(edit), "in.mp4", has_audio=True, ass_file="captions.ass")
    assert plan.total_frames == m.duration_in_frames(edit["video"])
    assert len(plan.inputs) == 1 and plan.inputs[0][-2:] == ["-i", "in.mp4"]     # nearby pieces share one decode
    assert "subtitles=filename=captions.ass" in plan.graph and "[outv]" in plan.graph and "[outa]" in plan.graph
    assert "overlay=x='-w+W*min(1,(n+1)/" in plan.graph                          # progress bar
    far = {**edit, "video": [{"id": "a", "srcStart": 1.0, "srcEnd": 2.0}, {"id": "b", "srcStart": 200.0, "srcEnd": 201.0}]}
    assert len(graph.build_plan(props_for(far), "in.mp4", has_audio=False).inputs) == 2
    silent = graph.build_plan(props_for(edit), "in.mp4", has_audio=False)
    assert "anullsrc" in silent.graph


def test_zoom_and_moving_crop_become_sendcmd_scripts():
    edit = edit_for()
    assert edit["zooms"], "the smart edit of this clip has zoom keys"
    track = {"segments": [{"start": 0, "end": 10, "layout": "crop",
                           "keys": [{"t": 0, "cx": 0.3, "cy": 0.5}, {"t": 6, "cx": 0.7, "cy": 0.5}]}]}
    plan = graph.build_plan(props_for(edit, track), "in.mp4", has_audio=True)
    assert "zoom.cmd" in plan.files and "crop@zoom" in plan.graph
    moving = [name for name in plan.files if name != "zoom.cmd"]
    assert moving and all(plan.files[n].strip().endswith(";") for n in moving)
    still = graph.build_plan(props_for({**edit, "zooms": []}), "in.mp4", has_audio=True)
    assert still.files == {}


# ── real renders ───────────────────────────────────────────────────────────
def _probe_frames(path: Path) -> int:
    import subprocess

    out = subprocess.run([ffmpeg.binaries()[1], "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                          "stream=nb_read_frames", "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout
    return int(out.strip().split(",")[0])


@pytest.mark.parametrize("layout", ["crop", "letterbox", "split"])
def test_render_real_file(tmp_path: Path, sample_video: Path, layout: str):
    edit = smart_edit.build_edit(WORDS, 0.5, 9.0, keywords=["people"], hook="Why does this work?")
    seg: dict = {"start": 0, "end": 12, "layout": layout, "keys": [{"t": 0, "cx": 0.3, "cy": 0.5}, {"t": 9, "cx": 0.7, "cy": 0.5}]}
    if layout == "split":
        seg["keys2"] = [{"t": 0, "cx": 0.8, "cy": 0.5}]
    props = props_for(edit, {"version": 1, "srcW": 1280, "srcH": 720, "segments": [seg]})
    assert fastrender.unsupported_reason(props) is None
    out = tmp_path / "out.mp4"
    seen: list[float] = []
    ff, fp = ffmpeg.binaries()
    info = fastrender.render(props, sample_video, out, tmp_path / "work", ffmpeg=ff, ffprobe=fp, has_audio=True, on_progress=seen.append)
    probe = ffmpeg.probe(out)
    assert (probe["width"], probe["height"], probe["video_codec"], probe["audio_codec"]) == (1080, 1920, "h264", "aac")
    assert _probe_frames(out) == info["frames"] == m.duration_in_frames(edit["video"])
    assert probe["duration"] == pytest.approx(info["frames"] / 30, abs=0.08)
    assert seen and max(seen) > 0.5


def test_render_cancel_stops_ffmpeg(tmp_path: Path, sample_video: Path):
    edit = smart_edit.build_edit(WORDS, 0.5, 11.5)

    class Stop(Exception):
        pass

    def cancel(_f: float) -> None:
        raise Stop()

    ff, fp = ffmpeg.binaries()
    with pytest.raises(Stop):
        fastrender.render(props_for(edit), sample_video, tmp_path / "o.mp4", tmp_path / "w", ffmpeg=ff, ffprobe=fp, has_audio=True, on_progress=cancel)


# ── worker integration ─────────────────────────────────────────────────────
def _ready_clip(db, settings, project, video: Path, edit: dict | None) -> tuple[str, str]:
    sid = add_source(db, settings, project, video)
    db.update("source_videos", sid, {"width": 1280, "height": 720, "duration_sec": 12.0, "status": "ready"})
    track = {"version": 1, "srcW": 1280, "srcH": 720, "segments": [{"start": 0, "end": 12, "layout": "crop", "keys": [{"t": 0, "cx": 0.5, "cy": 0.5}]}]}
    cid = db.insert("clips", {"project_id": project, "source_video_id": sid, "start_sec": 0.5, "end_sec": 9.0, "status": "candidate",
                              "caption_style_id": "bold-outline", "crop_track": track, **({"edit_state": edit} if edit else {})})
    rid = db.insert("renders", {"clip_id": cid, "status": "queued", "options": {}})
    return cid, rid


def test_render_clip_uses_the_fast_renderer_and_never_starts_node(db, settings, project, sample_video, monkeypatch):
    edit = smart_edit.build_edit(WORDS, 0.5, 9.0, hook="Why does this work?")
    _cid, rid = _ready_clip(db, settings, project, sample_video, edit)

    def no_remotion(*_a, **_k):
        raise AssertionError("the Studio renderer must not run for an edit the fast renderer supports")

    monkeypatch.setattr(render_step, "run_remotion", no_remotion)
    res = render_step.render_clip(make_ctx(settings, db, project, {"render_id": rid}), rid)
    row = db.get("renders", rid)
    assert row["status"] == "ready" and row["options"]["rendered_by"] == "fast" and "fast_skipped" not in row["options"]
    assert (row["width"], row["height"], row["video_codec"], row["audio_codec"]) == (1080, 1920, "h264", "aac")
    assert settings.storage_path(res["storage_key"]).exists() and settings.storage_path(row["cover_key"]).exists()
    assert row["lufs"] is not None and abs(row["lufs"] - (-14.0)) < 1.5


def test_render_clip_falls_back_to_studio(db, settings, project, sample_video, monkeypatch):
    calls: list[str] = []

    def fake_remotion(_ctx, _props, raw: Path, _cover, **_k):
        calls.append("studio")
        ffmpeg.run_ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=1080x1920:r=30:d=1", "-f", "lavfi", "-i", "sine=d=1",
                           "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(raw)])
        return {"frames": 30}

    monkeypatch.setattr(render_step, "run_remotion", fake_remotion)
    # 1. an edit the fast renderer does not draw
    edit = {**smart_edit.build_edit(WORDS, 0.5, 9.0), "look": "warm"}
    _c, rid = _ready_clip(db, settings, project, sample_video, edit)
    render_step.render_clip(make_ctx(settings, db, project, {"render_id": rid}), rid)
    opts = db.get("renders", rid)["options"]
    assert opts["rendered_by"] == "studio" and "look" in opts["fast_skipped"] and calls == ["studio"]
    # 2. the person asked for Studio
    _c, rid2 = _ready_clip(db, settings, project, sample_video, smart_edit.build_edit(WORDS, 0.5, 9.0))
    db.update("renders", rid2, {"options": {"engine": "studio"}})
    render_step.render_clip(make_ctx(settings, db, project, {"render_id": rid2}), rid2)
    opts2 = db.get("renders", rid2)["options"]
    assert opts2["rendered_by"] == "studio" and "fast_skipped" not in opts2 and calls == ["studio", "studio"]
    # 3. the fast renderer blows up: Studio still delivers
    from klipz_worker import fastrender as fr

    def boom(*_a, **_k):
        raise RuntimeError("ffmpeg exited 1: boom")

    monkeypatch.setattr(fr, "render", boom)
    _c, rid3 = _ready_clip(db, settings, project, sample_video, smart_edit.build_edit(WORDS, 0.5, 9.0))
    render_step.render_clip(make_ctx(settings, db, project, {"render_id": rid3}), rid3)
    opts3 = db.get("renders", rid3)["options"]
    assert opts3["rendered_by"] == "studio" and "boom" in opts3["fast_skipped"] and len(calls) == 3


def test_requested_engine_precedence(settings):
    assert render_step.requested_engine({}, settings) == "auto"
    assert render_step.requested_engine({"engine": "studio"}, settings) == "studio"
    assert render_step.requested_engine({"engine": "nonsense"}, settings) == "auto"
    import dataclasses

    assert render_step.requested_engine({}, dataclasses.replace(settings, render_engine="studio")) == "studio"
    assert render_step.requested_engine({"engine": "fast"}, dataclasses.replace(settings, render_engine="studio")) == "fast"


# ── manual framing (crop / zoom / position set in the editor) ──────────────
def test_manual_frame_overrides_the_automatic_track():
    auto = {"version": 1, "srcW": 1280, "srcH": 720, "segments": [{"start": 0, "end": 99, "layout": "letterbox", "keys": []}]}
    assert m.effective_crop_track({}, auto, 1280, 720) is auto
    assert m.effective_crop_track({"frame": None}, auto, 1280, 720) is auto
    manual = m.effective_crop_track({"frame": {"layout": "crop", "cx": 0.25, "cy": 0.5, "zoom": 2}}, auto, 1280, 720)
    lay = m.layout_at(manual, 123.0, 1280, 720)
    assert lay.layout == "crop" and lay.panes[0].src == m.Rect(0.25 * 1280 - 101.25, 180.0, 202.5, 360.0)
    # values are clamped like cleanFrame() in crop.ts
    wild = m.manual_crop_track({"layout": "zzz", "cx": -5, "cy": "x", "zoom": 99}, 1280, 720)["segments"][0]
    assert (wild["layout"], wild["keys"][0]["cx"], wild["keys"][0]["cy"], wild["zoom"]) == ("crop", 0.0, 0.5, 4.0)
    fit = m.layout_at(m.manual_crop_track({"layout": "letterbox", "cx": 0.5, "cy": 0.5, "zoom": 1}, 1280, 720), 0, 1280, 720)
    assert fit.layout == "letterbox" and fit.blurred_background


def test_manual_frame_is_used_by_the_fast_renderer(tmp_path: Path, sample_video: Path):
    edit = {**smart_edit.build_edit(WORDS, 0.5, 5.0), "frame": {"layout": "crop", "cx": 0.8, "cy": 0.3, "zoom": 2.5}}
    auto = {"version": 1, "srcW": 1280, "srcH": 720, "segments": [{"start": 0, "end": 12, "layout": "letterbox", "keys": []}]}
    plan = graph.build_plan(props_for(edit, auto), "in.mp4", has_audio=True)
    assert "gblur" not in plan.graph and "crop=162:288:" in plan.graph   # the manual window, not the letterbox
    ff, fp = ffmpeg.binaries()
    out = tmp_path / "manual.mp4"
    fastrender.render(props_for(edit, auto), sample_video, out, tmp_path / "w", ffmpeg=ff, ffprobe=fp, has_audio=True)
    probe = ffmpeg.probe(out)
    assert (probe["width"], probe["height"]) == (1080, 1920)


def test_hook_dim_is_drawn_by_the_filter_graph():
    edit = edit_for()
    total = m.duration_in_frames(edit["video"])
    dim = ass.hook_dim(edit, total)
    assert dim[0] == (0, 0.0) and dim[-1][1] == 0.0 and max(a for _n, a in dim) == pytest.approx(ass.HOOK_DIM.a, abs=1e-3)
    assert [n for n, _a in dim] == sorted({n for n, _a in dim})
    plan = graph.build_plan(props_for(edit), "in.mp4", has_audio=True, ass_file="captions.ass", dim=dim)
    assert "lutyuv@dim=" in plan.graph and f"enable='lt(n,{dim[-1][0]})'" in plan.graph and "dim.cmd" in plan.files
    assert plan.graph.index("lutyuv@dim") < plan.graph.index("subtitles=")       # under the card and the captions
    assert "16+(val-16)*0.62" in plan.files["dim.cmd"]                           # full dim: 38 % of the way to black
    # the ASS script then leaves the full-frame rectangle out
    with_dim = ass.build_ass(edit, [], total).count("Dialogue:")
    without = ass.build_ass(edit, [], total, draw_dim=False).count("Dialogue:")
    assert without < with_dim
    assert ass.hook_dim({**edit, "hook": {**edit["hook"], "enabled": False}}, total) == []
    assert "lutyuv" not in graph.build_plan(props_for(edit), "in.mp4", has_audio=True).graph


# ── each piece of a split clip can have its own crop, look and volume ─────────
def _pieces_edit() -> dict:
    close = {"layout": "crop", "cx": 0.2, "cy": 0.5, "zoom": 2}
    return {**smart_edit.build_edit(WORDS, 0.5, 5.0), "volume": 0.8, "video": [
        {"id": "a", "srcStart": 0.5, "srcEnd": 2.5},                                  # the clip's framing
        {"id": "b", "srcStart": 2.5, "srcEnd": 4.0, "frame": close},                  # its own close crop
        {"id": "c", "srcStart": 4.0, "srcEnd": 5.0, "volume": 0.3,
         "frame": {"layout": "crop", "cx": 0.9, "cy": 0.5, "zoom": 1.5}},             # another crop, quieter
    ]}


def test_piece_helpers_fall_back_to_the_clip():
    auto = {"version": 1, "srcW": 1280, "srcH": 720, "segments": [{"start": 0, "end": 99, "layout": "letterbox", "keys": []}]}
    edit = {"frame": {"layout": "crop", "cx": 0.5, "cy": 0.5, "zoom": 1}, "look": "warm", "volume": 0.8}
    assert m.piece_crop_track({}, {"id": "a"}, auto, 1280, 720) is auto
    assert m.piece_crop_track(edit, {"id": "a"}, auto, 1280, 720)["segments"][0]["zoom"] == 1.0
    own = m.piece_crop_track(edit, {"frame": {"layout": "crop", "cx": 0.2, "cy": 0.5, "zoom": 2}}, auto, 1280, 720)
    assert (own["segments"][0]["zoom"], own["segments"][0]["keys"][0]["cx"]) == (2.0, 0.2)
    assert m.piece_look(edit, {}) == "warm" and m.piece_look(edit, {"look": "bw"}) == "bw" and m.piece_look({}, None) == "none"
    assert m.piece_volume(edit, {}) == 0.8 and m.piece_volume(edit, {"volume": 0}) == 0.0
    assert m.piece_volume(edit, {"volume": 9}) == 1.5 and m.piece_volume(edit, {"volume": "x"}) == 0.8 and m.piece_volume({}, {}) == 1.0


def test_each_piece_gets_its_own_crop_and_volume_in_the_fast_renderer(tmp_path: Path, sample_video: Path):
    edit = _pieces_edit()
    auto = {"version": 1, "srcW": 1280, "srcH": 720, "segments": [{"start": 0, "end": 12, "layout": "letterbox", "keys": []}]}
    plan = graph.build_plan(props_for(edit, auto), "in.mp4", has_audio=True)
    # one decode (the pieces follow each other in the source), three differently framed stretches
    assert len(plan.inputs) == 1
    assert "gblur" in plan.graph                                   # piece a: the automatic letterbox
    assert "crop=202:360:" in plan.graph                           # piece b: 405x720 window at zoom 2
    assert "crop=270:480:" in plan.graph                           # piece c: at zoom 1.5
    assert "concat=n=3:v=1:a=0" in plan.graph
    # sound: each piece at its own level (the clip's 0.8 where it has none), no second gain on top
    assert plan.graph.count(",volume=0.8[") == 2 and ",volume=0.3[" in plan.graph and "]volume=1[outa]" in plan.graph
    assert plan.total_frames == m.duration_in_frames(edit["video"]) == 135

    ff, fp = ffmpeg.binaries()
    out = tmp_path / "pieces.mp4"
    fastrender.render(props_for(edit, auto), sample_video, out, tmp_path / "w", ffmpeg=ff, ffprobe=fp, has_audio=True)
    probe = ffmpeg.probe(out)
    assert (probe["width"], probe["height"]) == (1080, 1920) and probe["duration"] == pytest.approx(4.5, abs=0.1)


def test_two_pieces_with_the_same_crop_share_one_chain_and_plain_edits_are_unchanged():
    frame = {"layout": "crop", "cx": 0.2, "cy": 0.5, "zoom": 2}
    edit = {**_pieces_edit(), "video": [{"id": "a", "srcStart": 0.5, "srcEnd": 2.5, "frame": frame},
                                        {"id": "b", "srcStart": 2.5, "srcEnd": 4.0, "frame": dict(frame)}]}
    plan = graph.build_plan(props_for(edit), "in.mp4", has_audio=True)
    assert "concat=n=2:v=1" not in plan.graph and plan.graph.count("crop=202:360:") == 1
    # no piece has its own level: one gain for the whole clip, as before
    assert ",volume=" not in plan.graph and "]volume=0.8[outa]" in plan.graph


def test_a_piece_with_its_own_look_goes_to_the_studio_renderer():
    edit = _pieces_edit()
    assert fastrender.unsupported_reason(props_for(edit)) is None
    edit["video"][1]["look"] = "bw"
    assert "look" in (fastrender.unsupported_reason(props_for(edit)) or "")
    edit["video"][1]["look"] = "none"
    assert fastrender.unsupported_reason(props_for(edit)) is None
