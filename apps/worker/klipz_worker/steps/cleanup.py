"""Housekeeping: expired source media, stale upload parts, old finished jobs."""
from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path
from typing import Any, Optional

from ..db import now_iso
from ..runner import JobContext

log = logging.getLogger("klipz.cleanup")

PART_MAX_AGE = 24 * 3600
ORPHAN_MAX_AGE = 3600  # a folder whose project is gone (its delete met a file still in use)
JOB_RETENTION_DAYS = 30


def _inside(root: Path, p: Path) -> bool:
    try:
        p.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def safe_unlink(storage_root: Path, key: Optional[str]) -> int:
    """Delete storage/<key> if (and only if) it resolves inside the storage dir. Returns bytes freed."""
    if not key:
        return 0
    p = storage_root / key
    if not _inside(storage_root, p) or p.resolve() == storage_root.resolve():
        log.warning("refusing to delete outside storage: %r", key)
        return 0
    try:
        if not p.is_file():
            return 0
        size = p.stat().st_size
        p.unlink()
        return size
    except OSError as e:
        log.warning("could not delete %s: %s", p, e)
        return 0


def _is_part(name: str) -> bool:
    return name.endswith(".part") or ".part." in name


_BUSY_SQL = """
select 1 from jobs where status in ('queued','running') and id != :me and (
     json_extract(payload, '$.source_video_id') = :sid
  or json_extract(payload, '$.clip_id') in (select id from clips where source_video_id = :sid)
  or json_extract(payload, '$.render_id') in (
       select r.id from renders r join clips c on c.id = r.clip_id where c.source_video_id = :sid)
) limit 1
"""


def source_is_busy(db: Any, source_id: str, current_job_id: str = "") -> bool:
    """True while a queued or running job still needs this source (directly, or via its clips/renders)."""
    return db.conn.execute(_BUSY_SQL, {"sid": source_id, "me": current_job_id}).fetchone() is not None


def cleanup(ctx: JobContext, now: Optional[float] = None) -> dict[str, Any]:
    db, root = ctx.db, ctx.settings.storage_dir
    now = time.time() if now is None else now
    stamp = now_iso(now - time.time())

    # 1. expired source media (video + wav; the thumbnail stays)
    sources = freed = skipped = 0
    for s in db.many(
        "source_videos",
        "select * from source_videos where expires_at < ? and status != 'deleted'",
        stamp,
    ):
        if source_is_busy(db, s["id"], ctx.job["id"]):
            log.info("cleanup: keeping expired source %s, it still has queued/running jobs", s["id"])
            skipped += 1
            continue
        freed += safe_unlink(root, s.get("storage_key")) + safe_unlink(root, s.get("audio_key"))
        db.update("source_videos", s["id"], {"status": "deleted", "storage_key": None, "audio_key": None})
        sources += 1
    ctx.progress(0.4, "Expired sources removed", force=True)

    # 2. stale *.part files (abandoned uploads / interrupted writes) and render temp dirs
    parts = 0
    for base in (root, ctx.settings.data_dir / "tmp"):
        if not base.exists():
            continue
        for f in base.rglob("*"):
            try:
                if f.is_file() and _is_part(f.name) and now - f.stat().st_mtime > PART_MAX_AGE and _inside(base, f):
                    freed += f.stat().st_size
                    f.unlink()
                    parts += 1
            except OSError as e:
                log.warning("could not remove %s: %s", f, e)
    tmp = ctx.settings.data_dir / "tmp"
    if tmp.exists():
        for d in tmp.iterdir():
            try:
                if d.is_dir() and now - d.stat().st_mtime > PART_MAX_AGE and _inside(tmp, d):
                    shutil.rmtree(d, ignore_errors=True)
                    parts += 1
            except OSError:
                pass
    # 2b. folders left behind by a deleted project: Windows refuses to remove a file that is still open
    #     (a video being imported or previewed), so the delete in the app can leave some
    orphans = 0
    for kind, table in (("sources", "source_videos"), ("clips", "clips")):
        base = root / kind
        if not base.is_dir():
            continue
        known = {r[0] for r in db.conn.execute(f"select id from {table}").fetchall()}
        for d in base.iterdir():
            try:
                if d.is_dir() and d.name not in known and now - d.stat().st_mtime > ORPHAN_MAX_AGE and _inside(base, d):
                    freed += sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                    shutil.rmtree(d, ignore_errors=True)
                    orphans += 1
            except OSError as e:
                log.warning("could not remove %s: %s", d, e)
    ctx.progress(0.7, "Stale uploads removed", force=True)

    # 3. old finished jobs
    cutoff = now_iso(now - time.time() - JOB_RETENTION_DAYS * 86400)
    cur = db.conn.execute(
        "delete from jobs where status in ('succeeded','cancelled') and coalesce(finished_at, updated_at) < ? and id != ?",
        (cutoff, ctx.job["id"]),
    )
    jobs = cur.rowcount if cur.rowcount is not None else 0
    ctx.progress(1.0, "Cleanup done", force=True)
    result = {"sources_deleted": sources, "part_files_deleted": parts, "jobs_deleted": jobs, "bytes_freed": freed, "orphan_folders_deleted": orphans,
              "sources_kept_busy": skipped}
    log.info("cleanup: %s", result)
    return result


def handle_cleanup(ctx: JobContext) -> dict[str, Any]:
    return cleanup(ctx)


HANDLERS = {"cleanup": handle_cleanup}
