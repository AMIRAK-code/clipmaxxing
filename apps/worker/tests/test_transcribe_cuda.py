"""CUDA is tried at most once per process: a second attempt after a failure hangs inside CTranslate2."""
from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from klipz_worker import ffmpeg
from klipz_worker.steps import transcribe as T


@pytest.fixture(autouse=True)
def _reset_cuda_flag(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(T, "_CUDA_FAILED", False)
    monkeypatch.setattr(ffmpeg, "decode_mono_16k", lambda _p: np.ones(16000, dtype=np.float32))
    yield


def _transcriber(monkeypatch: pytest.MonkeyPatch, loads: list[str], cuda_breaks: bool) -> T.FasterWhisperTranscriber:
    tr = T.FasterWhisperTranscriber("tiny", device="auto")

    def load(device: str, _ctype: str) -> Any:
        loads.append(device)
        if device == "cuda" and cuda_breaks:
            raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
        return object()

    monkeypatch.setattr(tr, "_load", load)
    monkeypatch.setattr(tr, "_run", lambda *_a, **_k: {"language": "en", "words": [], "model": "fake"})
    return tr


def test_after_cuda_failed_once_it_is_never_tried_again(monkeypatch, tmp_path):
    monkeypatch.setattr(T, "cuda_usable", T.cuda_usable)
    import ctranslate2

    monkeypatch.setattr(ctranslate2, "get_cuda_device_count", lambda: 1, raising=False)
    loads: list[str] = []
    for _ in range(3):
        _transcriber(monkeypatch, loads, cuda_breaks=True).transcribe(tmp_path / "a.wav", 1.0, lambda _p: None)
    assert loads == ["cuda", "cpu", "cpu", "cpu"]


def test_without_a_cuda_device_only_the_cpu_is_used(monkeypatch, tmp_path):
    import ctranslate2

    monkeypatch.setattr(ctranslate2, "get_cuda_device_count", lambda: 0, raising=False)
    loads: list[str] = []
    _transcriber(monkeypatch, loads, cuda_breaks=False).transcribe(tmp_path / "a.wav", 1.0, lambda _p: None)
    assert loads == ["cpu"]


def test_a_working_cuda_device_is_used(monkeypatch, tmp_path):
    import ctranslate2

    monkeypatch.setattr(ctranslate2, "get_cuda_device_count", lambda: 1, raising=False)
    loads: list[str] = []
    _transcriber(monkeypatch, loads, cuda_breaks=False).transcribe(tmp_path / "a.wav", 1.0, lambda _p: None)
    assert loads == ["cuda"]
