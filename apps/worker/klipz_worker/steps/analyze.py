"""Analyze: ingest -> transcribe -> candidates -> features -> score -> select -> clips rows."""
from __future__ import annotations

import logging
from typing import Any, Optional

from ..runner import JobContext, PermanentError
from . import bounds
from . import segment as seg
from .ingest import ingest
from . import smart_edit
from .score import ScoredCandidate, pick_scorer, score_candidates
from .select import overlap_fraction, select_top
from .transcribe import transcribe

log = logging.getLogger("klipz.analyze")

DEFAULT_MAX_CLIPS = 8  # kept for callers that pass an explicit number
KEPT_OVERLAP = 0.5
MIN_AUTO_CLIPS, MAX_AUTO_CLIPS = 10, 50
ALT_OVERLAP = 0.34     # second pass: clips may share up to a third with one already picked
SELECT_OVERLAP = 0.10  # select_top()'s default: distinct clips share at most a tenth


def auto_clip_count(duration: float) -> int:
    """How many potential clips to offer when nobody asked for a number: about one per 20 s of video,
    at least 10 and at most 50. (Non-overlap decides how many a short video can really give.)"""
    return int(min(MAX_AUTO_CLIPS, max(MIN_AUTO_CLIPS, round((duration or 0) / 20.0))))


def analyze(
    ctx: JobContext,
    source_video_id: str,
    max_clips: Optional[int] = None,
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
    if max_clips is None:
        max_clips = auto_clip_count(duration)
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
    if len(chosen) < max_clips:
        # distinct moments first; then alternative cuts that share at most a third with a picked one
        chosen += select_top([s for s in pool if s not in chosen], max_clips - len(chosen), ALT_OVERLAP, taken=chosen)
        chosen.sort(key=lambda s: -s.score)
    refine_edges(chosen, sentences, duration, protected)

    # Edits are built before the write transaction: reading the audio for each clip must not hold the lock.
    audio_path = ctx.settings.storage_path(source["audio_key"]) if source.get("audio_key") else None
    edits: list[Optional[dict[str, Any]]] = []
    for s in chosen:
        edit = None
        if ctx.settings.smart_edit:
            try:
                edit = smart_edit.build_edit(words, s.start, s.end, keywords=s.breakdown.get("keywords") or [],
                                             hook=s.hook, style_id="bold-outline",
                                             snap=smart_edit.snap_for(audio_path, s.start, s.end))
            except Exception as e:  # noqa: BLE001 - never lose the clips over an edit nicety
                log.warning("smart edit failed for %.1f-%.1f (%s); clip left unedited", s.start, s.end, e)
        edits.append(edit)

    ids: list[str] = []
    db.conn.execute("BEGIN IMMEDIATE")  # replace candidates atomically: a crash must not leave zero clips
    try:
        for cid in doomed:
            db.conn.execute("delete from clips where id = ?", (cid,))
        for s, edit in zip(chosen, edits):
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


def refine_edges(chosen: list[ScoredCandidate], sentences: list[seg.Sentence], duration: float,
                 protected: list[dict[str, Any]]) -> None:
    """Give each chosen clip its context and a finished ending (bounds.refine_bounds), in place. A clip
    keeps its edges when the new ones would overlap another clip more than the selection allowed."""
    for s in chosen:
        r = bounds.refine_bounds(s.start, s.end, sentences, duration)
        if not r.changed:
            continue
        ok = all(
            overlap_fraction(r.start, r.end, o.start, o.end) <= max(SELECT_OVERLAP, overlap_fraction(s.start, s.end, o.start, o.end))
            for o in chosen if o is not s
        ) and all(overlap_fraction(r.start, r.end, p["start_sec"], p["end_sec"]) <= KEPT_OVERLAP for p in protected)
        if not ok:
            continue
        s.cand = seg.Candidate(r.start, r.end, r.sentences or s.cand.sentences, before=s.cand.before)
        s.breakdown = {**s.breakdown, "edges": r.reasons}


def handle_analyze(ctx: JobContext) -> dict[str, Any]:
    sid = ctx.payload.get("source_video_id")
    if not sid:
        raise PermanentError("payload.source_video_id is required")
    raw = ctx.payload.get("max_clips")
    max_clips: Optional[int] = None  # None = as many as the video's length suggests
    if raw not in (None, "", 0):
        try:
            max_clips = max(1, min(100, int(raw)))
        except (TypeError, ValueError):
            raise PermanentError("payload.max_clips must be an integer") from None
    return analyze(ctx, sid, max_clips, bool(ctx.payload.get("force")), retranscribe=bool(ctx.payload.get("retranscribe")))
