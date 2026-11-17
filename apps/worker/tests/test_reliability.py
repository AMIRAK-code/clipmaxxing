"""Cancel / hang safety: ffmpeg never outlives its job, stuck runs are stopped, failing AI providers
and cancelled transcriptions do not keep the single worker busy."""
from __future__ import annotations

import subprocess
import sys
import time
from typing import Any

import numpy as np
import pytest

from klipz_worker import ffmpeg as ff
from klipz_worker.runner import JobCancelled
from klipz_worker.steps import score as sc
from klipz_worker.steps import transcribe as transcribe_mod
from klipz_worker.steps.transcribe import FasterWhisperTranscriber

# Stands in for ffmpeg: prints a stats line ("time=...") every 50 ms until killed, or goes silent.
CHATTY = "import time\nwhile True:\n    print('frame=1 time=00:00:01.00 bitrate=1', flush=True)\n    time.sleep(0.05)\n"
SILENT = "import time\nprint('frame=1 time=00:00:00.10', flush=True)\ntime.sleep(600)\n"


@pytest.fixture()
def fake_ffmpeg(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Route the ffmpeg command to a small Python script; record the process to check it was stopped."""
    state: dict[str, Any] = {"script": CHATTY, "procs": []}
    real = subprocess.Popen

    def popen(cmd: Any, *args: Any, **kw: Any) -> subprocess.Popen:
        if isinstance(cmd, list) and cmd and cmd[0] == "FAKE_FFMPEG":
            script = state["script"]
            if kw.get("stderr") is subprocess.PIPE:  # run_ffmpeg reads stderr; _frame_values reads stdout
                script = "import sys\nsys.stdout = sys.stderr\n" + script
            p = real([sys.executable, "-c", script], *args, **kw)
            state["procs"].append(p)
            return p
        return real(cmd, *args, **kw)

    monkeypatch.setattr(ff.subprocess, "Popen", popen)
    monkeypatch.setattr(ff, "binaries", lambda: ("FAKE_FFMPEG", "FAKE_FFPROBE"))
    yield state
    for p in state["procs"]:
        if p.poll() is None:
            p.kill()


def test_run_ffmpeg_stops_ffmpeg_when_the_job_is_cancelled(fake_ffmpeg: dict[str, Any]) -> None:
    calls = {"n": 0}

    def on_progress(_p: float) -> None:
        calls["n"] += 1
        if calls["n"] >= 3:
            raise JobCancelled()

    with pytest.raises(JobCancelled):
        ff.run_ffmpeg(["-i", "x.mp4", "out.mp4"], duration=10, on_progress=on_progress)
    [proc] = fake_ffmpeg["procs"]
    assert proc.poll() is not None  # not left running in the background


def test_run_ffmpeg_stops_a_run_that_prints_nothing(fake_ffmpeg: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    fake_ffmpeg["script"] = SILENT
    monkeypatch.setattr(ff, "STALL_SEC", 0.5)
    t0 = time.monotonic()
    with pytest.raises(ff.FfmpegError, match="no progress"):
        ff.run_ffmpeg(["-i", "x.mp4", "out.mp4"])
    assert time.monotonic() - t0 < 30
    assert fake_ffmpeg["procs"][0].poll() is not None


def test_frame_scan_stops_ffmpeg_when_the_job_is_cancelled(fake_ffmpeg: dict[str, Any]) -> None:
    fake_ffmpeg["script"] = "import time\nwhile True:\n    print('frame:1 pts:1 pts_time:1.5', flush=True)\n    print('lavfi.scene_score=0.1', flush=True)\n    time.sleep(0.05)\n"
    seen = {"n": 0}

    def on_time(_t: float) -> None:
        seen["n"] += 1
        if seen["n"] >= 3:
            raise JobCancelled()

    with pytest.raises(JobCancelled):
        ff._frame_values(["-i", "x.mp4"], "lavfi.scene_score", on_time)
    assert fake_ffmpeg["procs"][0].poll() is not None


def test_ai_scoring_stops_calling_a_provider_that_keeps_failing() -> None:
    calls = {"n": 0}

    def call(_batch: Any) -> Any:
        calls["n"] += 1
        raise RuntimeError("401 invalid api key")

    class Cand:  # _rate_batched only hands the candidate to the heuristic fallback
        pass

    rated: list[Any] = []

    class Fallback:
        def _rate_one(self, c: Any) -> str:
            rated.append(c)
            return "heuristic"

    orig = sc.HeuristicScorer
    sc.HeuristicScorer = Fallback  # type: ignore[assignment,misc]
    try:
        out = sc._rate_batched(call, [Cand() for _ in range(5 * sc.BATCH_SIZE)], "test")
    finally:
        sc.HeuristicScorer = orig  # type: ignore[misc]
    assert calls["n"] == sc.MAX_FAILED_BATCHES  # not one failing call per batch
    assert out == ["heuristic"] * (5 * sc.BATCH_SIZE)


def test_ai_scoring_keeps_going_after_a_single_failed_batch() -> None:
    calls = {"n": 0}

    def call(batch: Any) -> Any:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("timeout")
        return {"ratings": []}  # valid shape, no items: heuristic for each, but the model was reached

    class Fallback:
        def _rate_one(self, c: Any) -> str:
            return "heuristic"

    orig = sc.HeuristicScorer
    sc.HeuristicScorer = Fallback  # type: ignore[assignment,misc]
    try:
        sc._rate_batched(call, [object() for _ in range(3 * sc.BATCH_SIZE)], "test")
    finally:
        sc.HeuristicScorer = orig  # type: ignore[misc]
    assert calls["n"] == 3


def test_cancelled_transcription_is_not_restarted_on_the_cpu(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    tr = FasterWhisperTranscriber("small", device="auto")
    # CUDA is only tried where it can work (and not after an earlier failure): make it the first attempt here
    monkeypatch.setattr(transcribe_mod, "cuda_usable", lambda: True)
    monkeypatch.setattr(ff, "decode_mono_16k", lambda _p: np.ones(16000, dtype=np.float32))
    loads: list[str] = []
    monkeypatch.setattr(tr, "_load", lambda device, ctype: loads.append(device) or object())

    def run(_model: Any, _audio: Any, _duration: float, on_progress: Any) -> Any:
        on_progress(0.5)
        return {}

    monkeypatch.setattr(tr, "_run", run)

    def on_progress(_p: float) -> None:
        raise JobCancelled()

    with pytest.raises(JobCancelled):
        tr.transcribe(tmp_path / "audio.wav", 1.0, on_progress)
    assert loads == ["cuda"]  # the first attempt only, no CPU retry after the cancel
