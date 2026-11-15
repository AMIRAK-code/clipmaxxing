"""KLIPZ's own speech-model folder: adopt from the Hugging Face cache, download, self-repair."""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from klipz_worker import whisper_model as wm
from klipz_worker.steps import transcribe as tr

FILES = {"model.bin": b"M" * 2_000_000, "config.json": b"{}", "tokenizer.json": b"{}", "vocabulary.txt": b"a\nb\n"}


def make_snapshot(folder: Path, files: dict[str, bytes] = FILES) -> Path:
    folder.mkdir(parents=True)
    for name, data in files.items():
        (folder / name).write_bytes(data)
    return folder


def test_folder_name_is_filesystem_safe():
    assert wm.folder_name("small") == "whisper-small"
    assert wm.folder_name("Systran/faster-whisper-large-v3") == "whisper-Systran--faster-whisper-large-v3"


def test_is_usable_needs_every_file_and_a_real_model(tmp_path: Path):
    ok = make_snapshot(tmp_path / "ok")
    assert wm.is_usable(ok)
    for missing in ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt"):
        broken = make_snapshot(tmp_path / f"no-{missing}", {k: v for k, v in FILES.items() if k != missing})
        assert not wm.is_usable(broken), missing
    stub = make_snapshot(tmp_path / "stub", {**FILES, "model.bin": b"tiny"})
    assert not wm.is_usable(stub)
    assert not wm.is_usable(tmp_path / "missing")
    assert wm.is_usable(make_snapshot(tmp_path / "json-vocab", {**{k: v for k, v in FILES.items() if k != "vocabulary.txt"}, "vocabulary.json": b"[]"}))


def test_adopts_from_the_cache_without_network(tmp_path: Path):
    cached = make_snapshot(tmp_path / "hf" / "snapshot")
    calls: list[dict] = []

    def download(model: str, **kw) -> str:
        calls.append(kw)
        assert kw.get("local_files_only") is True, "a readable cache must not trigger a download"
        return str(cached)

    path = wm.ensure_model("small", tmp_path / "models", download=download)
    assert Path(path) == tmp_path / "models" / "whisper-small" and wm.is_usable(Path(path))
    assert (Path(path) / "model.bin").read_bytes() == FILES["model.bin"]
    assert not (tmp_path / "models" / "whisper-small.part").exists()
    try:  # same drive: a hard link, no second copy on disk
        assert os.path.samefile(Path(path) / "model.bin", cached / "model.bin")
    except OSError:
        pass
    # second call: the folder is used as it is, nothing is asked of the downloader
    assert wm.ensure_model("small", tmp_path / "models", download=lambda *a, **k: pytest.fail("no download expected")) == path
    assert len(calls) == 1


def test_downloads_plain_files_when_the_cache_cannot_be_read(tmp_path: Path):
    """The failure from the field: the cache folder exists but model.bin cannot be opened."""
    cached = make_snapshot(tmp_path / "hf" / "snapshot", {k: v for k, v in FILES.items() if k != "model.bin"})
    statuses: list[str] = []

    def download(model: str, **kw) -> str:
        if kw.get("local_files_only"):
            return str(cached)
        out = Path(kw["output_dir"])
        make_snapshot(out)
        (out / ".cache").mkdir()
        return str(out)

    path = Path(wm.ensure_model("small", tmp_path / "models", statuses.append, download=download))
    assert wm.is_usable(path) and not (path / ".cache").exists()
    assert statuses == ["Downloading the speech model 'small' (one time)"]


def test_downloads_when_nothing_is_cached_and_reports_an_incomplete_download(tmp_path: Path):
    def download(model: str, **kw) -> str:
        if kw.get("local_files_only"):
            raise FileNotFoundError("not cached")
        return str(make_snapshot(Path(kw["output_dir"])))

    assert wm.is_usable(Path(wm.ensure_model("base", tmp_path / "models", download=download)))

    def truncated(model: str, **kw) -> str:
        if kw.get("local_files_only"):
            raise FileNotFoundError("not cached")
        return str(make_snapshot(Path(kw["output_dir"]), {**FILES, "model.bin": b""}))

    with pytest.raises(RuntimeError, match="did not download completely"):
        wm.ensure_model("medium", tmp_path / "models", download=truncated)
    assert not (tmp_path / "models" / "whisper-medium").exists() and not (tmp_path / "models" / "whisper-medium.part").exists()


def test_a_broken_folder_is_rebuilt(tmp_path: Path):
    final = make_snapshot(tmp_path / "models" / "whisper-small", {**FILES, "model.bin": b""})  # e.g. an interrupted copy
    cached = make_snapshot(tmp_path / "hf")
    path = wm.ensure_model("small", tmp_path / "models", download=lambda m, **k: str(cached))
    assert Path(path) == final and wm.is_usable(final)


def test_a_folder_given_by_the_person_is_used_unchanged(tmp_path: Path):
    mine = make_snapshot(tmp_path / "my-model")
    assert wm.ensure_model(str(mine), tmp_path / "models", download=lambda *a, **k: pytest.fail("no download")) == str(mine)


def test_transcriber_loads_from_the_local_folder(tmp_path: Path, monkeypatch):
    local = make_snapshot(tmp_path / "models" / "whisper-small")
    t = tr.FasterWhisperTranscriber("small", "cpu", tmp_path / "models")
    assert t.model_path() == str(local)
    # without a models folder it behaves as before (name handed to faster-whisper)
    assert tr.FasterWhisperTranscriber("small", "cpu").model_path() == "small"
    seen: list[str] = []
    import faster_whisper

    monkeypatch.setattr(faster_whisper, "WhisperModel", lambda path, **kw: seen.append(path) or "model")
    assert t._load("cpu", "int8") == "model" and seen == [str(local)]
