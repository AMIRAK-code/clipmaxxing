"""SQLite access + the job queue. The web app talks to the same file."""
from __future__ import annotations

import json
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

Row = dict[str, Any]


def now_iso(offset_seconds: float = 0.0) -> str:
    """UTC ISO-8601 with milliseconds; sorts lexicographically, matches JS toISOString()."""
    t = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def new_id() -> str:
    return str(uuid.uuid4())


def connect(db_path: Path | str, migrations_dir: Optional[Path] = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), isolation_level=None, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA synchronous = NORMAL")
    if migrations_dir is not None:
        migrate(conn, migrations_dir)
    return conn


def migrate(conn: sqlite3.Connection, migrations_dir: Path) -> None:
    files = sorted(f for f in migrations_dir.iterdir() if re.match(r"^\d+_.*\.sql$", f.name))
    for f in files:
        version = int(f.name.split("_", 1)[0])
        if version <= conn.execute("PRAGMA user_version").fetchone()[0]:
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            if version > conn.execute("PRAGMA user_version").fetchone()[0]:
                # executescript() would commit our transaction, so run statements one by one.
                for stmt in _split_sql(f.read_text(encoding="utf-8")):
                    conn.execute(stmt)
                conn.execute(f"PRAGMA user_version = {version}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise


def _split_sql(sql: str) -> list[str]:
    sql = re.sub(r"--[^\n]*", "", sql)
    return [s.strip() for s in sql.split(";") if s.strip()]


def _loads(row: Optional[sqlite3.Row], cols: Iterable[str]) -> Optional[Row]:
    if row is None:
        return None
    out = dict(row)
    for c in cols:
        v = out.get(c)
        if isinstance(v, str):
            try:
                out[c] = json.loads(v)
            except json.JSONDecodeError:
                out[c] = None
    return out


JSON_COLS = {
    "source_videos": ("scene_cuts", "energy"),
    "transcripts": ("words", "segments", "speakers"),
    "clips": ("score_breakdown", "crop_track", "edit_state"),
    "renders": ("options",),
    "jobs": ("payload", "result"),
}


class Database:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    # ── generic helpers ────────────────────────────────────────────────
    def one(self, table: str, sql: str, *params: Any) -> Optional[Row]:
        return _loads(self.conn.execute(sql, params).fetchone(), JSON_COLS.get(table, ()))

    def many(self, table: str, sql: str, *params: Any) -> list[Row]:
        cols = JSON_COLS.get(table, ())
        return [_loads(r, cols) for r in self.conn.execute(sql, params).fetchall()]  # type: ignore[misc]

    def get(self, table: str, id_: str) -> Optional[Row]:
        return self.one(table, f"select * from {table} where id = ?", id_)

    def insert(self, table: str, values: Row) -> str:
        values = dict(values)
        values.setdefault("id", new_id())
        cols = list(values)
        self.conn.execute(
            f"insert into {table} ({', '.join(cols)}) values ({', '.join('?' for _ in cols)})",
            [_enc(values[c]) for c in cols],
        )
        return values["id"]

    def update(self, table: str, id_: str, values: Row) -> None:
        if not values:
            return
        values = dict(values)
        if table in ("projects", "clips", "posts", "social_accounts", "jobs"):
            values.setdefault("updated_at", now_iso())
        cols = list(values)
        self.conn.execute(
            f"update {table} set {', '.join(f'{c} = ?' for c in cols)} where id = ?",
            [_enc(values[c]) for c in cols] + [id_],
        )

    def set_setting(self, key: str, value: str) -> None:
        self.conn.execute(
            "insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
            (key, value),
        )

    # ── queue ──────────────────────────────────────────────────────────
    def enqueue(
        self,
        type_: str,
        payload: Row,
        *,
        project_id: Optional[str] = None,
        dedupe_key: Optional[str] = None,
        parent_job_id: Optional[str] = None,
        max_attempts: int = 3,
    ) -> Row:
        """Idempotent: a live job with the same dedupe key is returned as-is."""
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            if dedupe_key:
                live = self.one(
                    "jobs", "select * from jobs where dedupe_key = ? and status in ('queued','running')", dedupe_key
                )
                if live:
                    self.conn.execute("COMMIT")
                    return live
            id_ = self.insert(
                "jobs",
                {
                    "project_id": project_id,
                    "type": type_,
                    "payload": payload,
                    "dedupe_key": dedupe_key,
                    "parent_job_id": parent_job_id,
                    "max_attempts": max_attempts,
                },
            )
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        return self.get("jobs", id_)  # type: ignore[return-value]

    def claim(self, worker_id: str, types: list[str], stale_seconds: int = 120) -> Optional[Row]:
        """Atomically take the oldest runnable job. Jobs whose worker stopped
        heartbeating are re-claimed, or dead-lettered when out of attempts."""
        if not types:
            return None
        now = now_iso()
        stale = now_iso(-stale_seconds)
        marks = ",".join("?" for _ in types)
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            self.conn.execute(
                """update jobs set status = 'dead', finished_at = ?, updated_at = ?,
                       error = coalesce(error, 'worker lost; attempts exhausted')
                   where status = 'running' and attempts >= max_attempts and coalesce(heartbeat_at, started_at) < ?""",
                (now, now, stale),
            )
            row = self.conn.execute(
                f"""select id from jobs
                    where type in ({marks}) and attempts < max_attempts and (
                      (status = 'queued' and run_after <= ?)
                      or (status = 'running' and coalesce(heartbeat_at, started_at) < ?)
                    )
                    order by run_after, created_at limit 1""",
                (*types, now, stale),
            ).fetchone()
            if row is None:
                self.conn.execute("COMMIT")
                return None
            self.conn.execute(
                """update jobs set status = 'running', locked_by = ?, heartbeat_at = ?, updated_at = ?,
                       started_at = coalesce(started_at, ?), attempts = attempts + 1, error = null
                   where id = ?""",
                (worker_id, now, now, now, row["id"]),
            )
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        return self.get("jobs", row["id"])

    def heartbeat(self, job_id: str) -> None:
        now = now_iso()
        self.conn.execute("update jobs set heartbeat_at = ?, updated_at = ? where id = ?", (now, now, job_id))

    def progress(self, job_id: str, progress: float, stage: Optional[str] = None) -> None:
        now = now_iso()
        p = min(1.0, max(0.0, float(progress)))
        self.conn.execute(
            "update jobs set progress = ?, stage = coalesce(?, stage), heartbeat_at = ?, updated_at = ? where id = ?",
            (p, stage, now, now, job_id),
        )

    def complete(self, job_id: str, result: Optional[Row] = None) -> None:
        now = now_iso()
        self.conn.execute(
            """update jobs set status = 'succeeded', progress = 1, result = ?, finished_at = ?, updated_at = ?,
                   error = null where id = ? and status = 'running'""",
            (json.dumps(result or {}), now, now, job_id),
        )

    def fail(self, job_id: str, error: str, *, retryable: bool = True, base_delay: float = 5.0) -> str:
        """Retry with exponential backoff, or dead-letter when attempts run out."""
        job = self.get("jobs", job_id)
        if job is None:
            return "missing"
        if job["status"] == "cancelled":
            return "cancelled"
        now = now_iso()
        if retryable and job["attempts"] < job["max_attempts"]:
            delay = min(600.0, base_delay * (2 ** (job["attempts"] - 1)))
            self.conn.execute(
                """update jobs set status = 'queued', run_after = ?, error = ?, locked_by = null,
                       heartbeat_at = null, updated_at = ? where id = ?""",
                (now_iso(delay), error[:4000], now, job_id),
            )
            return "queued"
        self.conn.execute(
            "update jobs set status = 'dead', error = ?, finished_at = ?, updated_at = ? where id = ?",
            (error[:4000], now, now, job_id),
        )
        return "dead"

    def is_cancelled(self, job_id: str) -> bool:
        r = self.conn.execute("select status from jobs where id = ?", (job_id,)).fetchone()
        return r is None or r["status"] == "cancelled"


def _enc(v: Any) -> Any:
    if isinstance(v, (dict, list)):
        return json.dumps(v, separators=(",", ":"))
    if isinstance(v, bool):
        return 1 if v else 0
    return v
