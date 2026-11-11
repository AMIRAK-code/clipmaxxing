from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from klipz_worker import ffmpeg
from klipz_worker.steps.transcribe import FasterWhisperTranscriber

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(os.environ.get("KLIPZ_SLOW_TESTS") != "1", reason="set KLIPZ_SLOW_TESTS=1 to run"),
]


def _speech_wav(tmp_path: Path) -> Path:
    """Synthesize speech with Windows SAPI (System.Speech) when available."""
    if sys.platform != "win32":
        pytest.skip("needs Windows SAPI to synthesize speech")
    raw = tmp_path / "speech.wav"
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        f"$s.SetOutputToWaveFile('{raw}');"
        "$s.Speak('Hello everyone. Today we are going to talk about how to build a simple video editing tool.');"
        "$s.Dispose()"
    )
    ps = shutil.which("powershell")
    if not ps:
        pytest.skip("powershell not found")
    subprocess.run([ps, "-NoProfile", "-Command", script], check=True, timeout=60)
    out = tmp_path / "speech16k.wav"
    ffmpeg.run_ffmpeg(["-i", str(raw), "-ar", "16000", "-ac", "1", str(out)])
    return out


def test_faster_whisper_tiny_real(tmp_path: Path):
    wav = _speech_wav(tmp_path)
    progress: list[float] = []
    res = FasterWhisperTranscriber("tiny", "auto").transcribe(wav, 8.0, progress.append)
    text = " ".join(w["w"] for w in res["words"]).lower()
    assert res["words"] and res["language"] == "en"
    assert "video" in text or "hello" in text
    assert all(w["e"] >= w["s"] for w in res["words"]) and progress
