"""Analyze: ingest -> transcribe -> candidates -> features -> score -> select -> clips rows."""
from __future__ import annotations

import logging
from typing import Any, Optional

from ..runner import JobContext, PermanentError
from . import segment as seg
from .ingest import ingest
from . import smart_edit
from .score import ScoredCandidate, pick_scorer, score_candidates
from .select import overlap_fraction, select_top
from .transcribe import transcribe

log = logging.getLogger("klipz.analyze")

DEFAULT_MAX_CLIPS = 8
KEPT_OVERLAP = 0.5


def analyze(
    ctx: JobContext,
    source_video_id: str,
    max_clips: int = DEFAULT_MAX_CLIPS,
    force: bool = False,
    scorer: Optional[Any] = None,
    retranscribe: bool = False,
) -> dict[str, Any]:
    """`retranscribe` replaces the stored transcript (e.g. after changing the Whisper model) before scoring;
    it only applies when the analysis really runs (no existing clips, or `force`)."""
    db = ctx.db
    source = db.get("source_videos", source_video_id)
    if source is None:
        raise PermanentError("source video not found")

    existing = db.many("clips", "select * from clips where source_video_id = ?", source_video_id)
    if existing and not force:
        ctx.progress(1.0, "Already analyzed", force=True)
        return {"source_video_id": source_video_id, "clips_created": 0, "clip_ids": [], "skipped": True}

    source = ingest(ctx.sub(0.0, 0.15), source_video_id)
    transcript = transcribe(ctx.sub(0.15, 0.6), source_video_id, force=retranscribe)

    ctx.progress(0.6, "Finding moments", force=True)
    duration = float(source.get("duration_sec") or 0)
    words = transcript["words"]
    sentences = seg.build_sentences(words)
    cands = seg.generate_candidates(sentences, duration)
    if not cands:
        raise PermanentError("no usable moments found (video too short or silent)")

    ctx.progress(0.7, f"Scoring {len(cands)} moments", force=True)
    sc = scorer or pick_scorer(ctx.settings)
    scored = score_candidates(cands, sc, source.get("energy"), source.get("scene_cuts"))

    ctx.progress(0.9, "Selecting best clips", force=True)
    protected: list[dict[str, Any]] = []
    doomed: list[str] = []
    if force:
        for c in existing:
            # replaceable = never touched by the person: no edit, or only the automatic smart edit (version 0)
            es = c.get("edit_state")
            untouched_auto = isinstance(es, dict) and es.get("auto") is True and int(c.get("edit_version") or 0) == 0
            if c["status"] == "candidate" and (es is None or untouched_auto):
                doomed.append(c["id"])
            else:
                protected.append(c)
    pool: list[ScoredCandidate] = [
        s for s in scored
        if all(overlap_fraction(s.start, s.end, p["start_sec"], p["end_sec"]) <= KEPT_OVERLAP for p in protected)
    ]
    chosen = select_top(pool, max_clips)

    ids: list[str] = []
    db.conn.execute("BEGIN IMMEDIATE")  # replace candidates atomically: a crash must not leave zero clips
    try:
        for cid in doomed:
            db.conn.execute("delete from clips where id = ?", (cid,))
        for s in chosen:
            edit = None
            if ctx.settings.smart_edit:
                try:
                    edit = smart_edit.build_edit(words, s.start, s.end, keywords=s.breakdown.get("keywords") or [],
                                                 hook=s.hook, style_id="bold-outline")
                except Exception as e:  # noqa: BLE001 - never lose the clips over an edit nicety
                    log.warning("smart edit failed for %.1f-%.1f (%s); clip left unedited", s.start, s.end, e)
            ids.append(db.insert("clips", {
                **({"edit_state": edit} if edit else {}),
                "project_id": source["project_id"],
                "source_video_id": source_video_id,
                "start_sec": s.start,
                "end_sec": s.end,
                "score": s.score,
                "score_breakdown": s.breakdown,
                "title": s.title,
                "hook": s.hook,
                "reason": s.reason,
                "status": "candidate",
                "caption_style_id": "bold-outline",
            }))
        db.conn.execute("COMMIT")
    except Exception:
        db.conn.execute("ROLLBACK")
        raise
    ctx.progress(1.0, f"Found {len(ids)} clips", force=True)
    return {"source_video_id": source_video_id, "clips_created": len(ids), "clip_ids": ids,
            "candidates": len(cands), "scorer": sc.name, "smart_edit": bool(ctx.settings.smart_edit)}


def handle_analyze(ctx: JobContext) -> dict[str, Any]:
    sid = ctx.payload.get("source_video_id")
    if not sid:
        raise PermanentError("payload.source_video_id is required")
    try:
        max_clips = int(ctx.payload.get("max_clips") or DEFAULT_MAX_CLIPS)
    except (TypeError, ValueError):
        raise PermanentError("payload.max_clips must be an integer") from None
    max_clips = max(1, min(50, max_clips))
    return analyze(ctx, sid, max_clips, bool(ctx.payload.get("force")), retranscribe=bool(ctx.payload.get("retranscribe")))
