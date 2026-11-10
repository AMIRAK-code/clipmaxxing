from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from klipz_worker import ffmpeg  # noqa: E402
from klipz_worker.config import REPO_ROOT, Settings  # noqa: E402
from klipz_worker.db import Database, connect  # noqa: E402


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path, worker_id="test-worker", poll_interval=0.01, stale_seconds=60)


@pytest.fixture()
def db(settings: Settings) -> Database:
    return Database(connect(settings.db_path, REPO_ROOT / "db" / "migrations"))


@pytest.fixture(scope="session")
def sample_video(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """12 s 1280x720 test clip: two visually different shots (cut at 6 s) with
    a tone that gets louder in the second half."""
    out = tmp_path_factory.mktemp("media") / "sample.mp4"
    ffmpeg.run_ffmpeg([
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=6",
        "-f", "lavfi", "-i", "smptebars=size=1280x720:rate=30:duration=6",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]volume='if(lt(t,6),0.1,0.9)':eval=frame[a]",
        "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", str(out),
    ])
    return out


@pytest.fixture()
def project(db: Database) -> str:
    return db.insert("projects", {"title": "Test"})


def add_source(db: Database, settings: Settings, project_id: str, video: Path) -> str:
    import shutil

    sid = db.insert("source_videos", {"project_id": project_id, "origin": "upload", "filename": video.name})
    key = f"sources/{sid}/source.mp4"
    shutil.copy(video, settings.storage_path(key))
    db.update("source_videos", sid, {"storage_key": key})
    return sid
