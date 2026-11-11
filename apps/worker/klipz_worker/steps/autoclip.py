"""Autoclip: analyze -> reframe -> render, one job fan-out. Idempotent on retry."""
from __future__ import annotations

import logging
from typing import Any, Optional

from ..runner import JobContext, PermanentError
from .analyze import analyze
from .reframe import reframe

log = logging.getLogger("klipz.autoclip")

DEFAULT_MAX_CLIPS = 5
LIVE = ("queued", "rendering", "ready")


def _current_render(db: Any, clip: dict[str, Any]) -> Optional[dict[str, Any]]:
    """A queued/rendering/ready render that covers the clip's current edit_version."""
    rows = db.many(
        "renders",
        "select * from renders where clip_id = ? and status in ('queued','rendering','ready') order by created_at desc",
        clip["id"],
    )
    ver = int(clip.get("edit_version") or 0)
    for r in rows:
        if r["status"] != "ready" or r.get("edit_version") == ver:  # unfinished renders read the live edit
            return r
    return None


def autoclip(ctx: JobContext, source_video_id: str, max_clips: int = DEFAULT_MAX_CLIPS, style_id: Optional[str] = None) -> dict[str, Any]:
    db = ctx.db
    source = db.get("source_videos", source_video_id)
    if source is None:
        raise PermanentError("source video not found")

    res = analyze(ctx.sub(0.0, 0.6), source_video_id, max_clips)
    clip_ids: list[str] = list(res.get("clip_ids") or [])
    if not clip_ids:  # re-run after a successful analyze: reuse the clips it created
        rows = db.many(
            "clips",
            "select id from clips where source_video_id = ? and status != 'discarded' order by score desc, start_sec limit ?",
            source_video_id, max_clips,
        )
        clip_ids = [r["id"] for r in rows]
    if not clip_ids:
        raise PermanentError("no clips to render")

    render_ids: list[str] = []
    n = len(clip_ids)
    for i, cid in enumerate(clip_ids):
        sub = ctx.sub(0.6 + 0.4 * i / n, 0.6 + 0.4 * (i + 0.9) / n)
        sub.progress(0.0, f"Reframing clip {i + 1}/{n}", force=True)
        reframe(sub, cid)
        if style_id:
            db.update("clips", cid, {"caption_style_id": style_id})
        clip = db.get("clips", cid)
        assert clip is not None
        existing = _current_render(db, clip)
        if existing is None:
            rid = db.insert("renders", {"clip_id": cid, "status": "queued", "options": {}})
        else:
            rid = existing["id"]
        render_ids.append(rid)
        if existing is None or existing["status"] == "queued":
            db.enqueue(
                "render", {"render_id": rid}, project_id=source["project_id"],
                dedupe_key=f"render:{rid}", parent_job_id=ctx.job["id"],
            )
    ctx.progress(1.0, f"Queued {len(render_ids)} renders", force=True)
    return {"clip_ids": clip_ids, "render_ids": render_ids}


def handle_autoclip(ctx: JobContext) -> dict[str, Any]:
    sid = ctx.payload.get("source_video_id")
    if not sid:
        raise PermanentError("payload.source_video_id is required")
    try:
        max_clips = int(ctx.payload.get("max_clips") or DEFAULT_MAX_CLIPS)
    except (TypeError, ValueError):
        raise PermanentError("payload.max_clips must be an integer") from None
    return autoclip(ctx, sid, max(1, min(50, max_clips)), ctx.payload.get("style_id") or None)


HANDLERS = {"autoclip": handle_autoclip}
