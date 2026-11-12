"""Polling job runner: claim → run handler → complete / retry / dead-letter."""
from __future__ import annotations

import logging
import threading
import time
import traceback
from datetime import datetime, timezone
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .config import Settings
from .db import Database, Row, connect, now_iso

log = logging.getLogger("klipz.worker")


class JobCancelled(Exception):
    pass


class PermanentError(Exception):
    """Retrying will not help (bad input, missing file…): dead-letter immediately."""


@dataclass
class JobContext:
    settings: Settings
    db: Database
    job: Row
    _lo: float = 0.0
    _hi: float = 1.0
    _last_write: float = 0.0

    @property
    def payload(self) -> Row:
        return self.job["payload"] or {}

    def progress(self, fraction: float, stage: Optional[str] = None, *, force: bool = False) -> None:
        """Report progress within the current sub-range; throttled to ~4 writes/s."""
        now = time.monotonic()
        if not force and stage is None and now - self._last_write < 0.25:
            return
        self._last_write = now
        p = self._lo + (self._hi - self._lo) * min(1.0, max(0.0, fraction))
        self.db.progress(self.job["id"], p, stage)
        if self.db.is_cancelled(self.job["id"]):
            raise JobCancelled()

    def sub(self, lo: float, hi: float) -> "JobContext":
        """A view of this job that maps 0..1 onto lo..hi of the parent range."""
        span = self._hi - self._lo
        return JobContext(self.settings, self.db, self.job, self._lo + span * lo, self._lo + span * hi)


Handler = Callable[[JobContext], Optional[Row]]


class Runner:
    def __init__(self, settings: Settings, handlers: dict[str, Handler], db: Optional[Database] = None):
        self.settings = settings
        self.handlers = handlers
        self.db = db or Database(connect(settings.db_path, settings.migrations_dir))
        self._stop = threading.Event()
        self.current_job: Optional[Row] = None

    def stop(self) -> None:
        self._stop.set()

    def run_once(self) -> bool:
        """Process at most one job. Returns False when the queue was empty."""
        job = self.db.claim(self.settings.worker_id, list(self.handlers), self.settings.stale_seconds)
        if job is None:
            return False
        self.current_job = job
        log.info("job %s %s attempt %s/%s", job["type"], job["id"], job["attempts"], job["max_attempts"])
        beat = _Heartbeat(self.settings, job["id"])
        beat.start()
        try:
            # AI tab settings (provider, keys, smart edit) are re-read for every job: no restart needed.
            from .ai_settings import effective

            result = self.handlers[job["type"]](JobContext(effective(self.settings), self.db, job))
            self.db.complete(job["id"], result)
            log.info("job %s succeeded", job["id"])
        except JobCancelled:
            log.info("job %s cancelled", job["id"])
        except PermanentError as e:
            log.warning("job %s failed permanently: %s", job["id"], e)
            self.db.fail(job["id"], str(e), retryable=False)
        except Exception as e:  # noqa: BLE001 - any handler failure becomes a retry
            log.error("job %s failed: %s\n%s", job["id"], e, traceback.format_exc())
            state = self.db.fail(job["id"], f"{type(e).__name__}: {e}")
            log.info("job %s → %s", job["id"], state)
        finally:
            beat.stop()
            self.current_job = None
        return True

    def maybe_enqueue_cleanup(self) -> bool:
        """At most one cleanup job per UTC day (dedupe key cleanup:<YYYY-MM-DD>), even after it finished."""
        if "cleanup" not in self.handlers:
            return False
        key = f"cleanup:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
        if self.db.one("jobs", "select id from jobs where dedupe_key = ? limit 1", key):
            return False
        self.db.enqueue("cleanup", {}, dedupe_key=key, max_attempts=2)
        return True

    def run_forever(self) -> None:
        log.info("worker %s polling %s", self.settings.worker_id, self.settings.db_path)
        next_cleanup_check = 0.0  # check at start, then hourly
        while not self._stop.is_set():
            try:
                self.db.set_setting("worker_heartbeat", now_iso())
                if time.monotonic() >= next_cleanup_check:
                    next_cleanup_check = time.monotonic() + 3600
                    self.maybe_enqueue_cleanup()
                if not self.run_once():
                    self._stop.wait(self.settings.poll_interval)
            except Exception:  # noqa: BLE001 - keep the loop alive
                log.error("runner loop error\n%s", traceback.format_exc())
                self._stop.wait(2.0)


class _Heartbeat:
    """Keeps a long job's lease fresh from its own connection/thread, and keeps
    the 'worker online' marker current while a job is busy."""

    def __init__(self, settings: Settings, job_id: str, interval: float = 5.0):
        self.settings, self.job_id, self.interval = settings, job_id, interval
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def _loop(self) -> None:
        db = Database(connect(self.settings.db_path))
        try:
            while not self._stop.wait(self.interval):
                try:
                    db.heartbeat(self.job_id)
                    db.set_setting("worker_heartbeat", now_iso())
                except Exception:  # noqa: BLE001
                    pass
        finally:
            db.conn.close()


def as_dict(x: Any) -> Row:
    return x if isinstance(x, dict) else {}
