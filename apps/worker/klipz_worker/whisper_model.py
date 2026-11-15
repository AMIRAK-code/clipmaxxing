"""Where the speech model lives: a plain folder of real files inside KLIPZ's data folder.

faster-whisper normally loads a model through the Hugging Face cache: a chain of symlinks
(snapshot -> blob -> shared blob store) that it re-validates online on every load. On Windows that
chain can end up unreadable for a process ("Unable to open file 'model.bin'") although the 480 MB
file is on disk, and every transcription starts with a dozen network requests.

So KLIPZ keeps its own copy: <data dir>/models/whisper-<name>/{model.bin, config.json, ...}.

  1. The folder is there and complete      -> use it. No network, no links.
  2. The Hugging Face cache has the model   -> adopt it (hard links to the real files: no extra disk
     and its files can be read                space; a copy when they are on another drive).
  3. Otherwise                              -> download plain files straight into the folder.

A folder that turns out to be broken is rebuilt, so a damaged download repairs itself on the next try.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
from pathlib import Path
from typing import Callable, Optional

log = logging.getLogger("klipz.whisper_model")

REQUIRED = ("model.bin", "config.json", "tokenizer.json")
OPTIONAL = ("preprocessor_config.json", "vocabulary.txt", "vocabulary.json")
MIN_MODEL_BYTES = 1_000_000

StatusFn = Callable[[str], None]


def folder_name(model: str) -> str:
    return "whisper-" + re.sub(r"[^A-Za-z0-9._-]+", "--", model.strip()).strip("-")


def is_usable(folder: Path) -> bool:
    """Every required file is a real, readable file and the model itself is not a stub."""
    try:
        for name in REQUIRED:
            p = folder / name
            if not p.is_file() or p.is_symlink():
                return False
            with open(p, "rb") as f:
                if not f.read(1):
                    return False
        if not any((folder / v).is_file() for v in ("vocabulary.txt", "vocabulary.json")):
            return False
        return (folder / "model.bin").stat().st_size >= MIN_MODEL_BYTES
    except OSError:
        return False


def _place(src: Path, dst: Path) -> None:
    """Hard link (same drive, no extra space) or copy the real file behind `src` to `dst`."""
    real = Path(os.path.realpath(src))
    with open(real, "rb") as f:  # proves the file can really be read by this process
        f.read(1)
    try:
        os.link(real, dst)
    except OSError:
        shutil.copyfile(real, dst)


def _swap_in(part: Path, final: Path) -> None:
    shutil.rmtree(final, ignore_errors=True)
    os.replace(part, final)


def adopt_cached(cached: Path, final: Path) -> bool:
    """Build `final` from a Hugging Face snapshot folder. False when that folder cannot be read."""
    part = final.with_name(final.name + ".part")
    shutil.rmtree(part, ignore_errors=True)
    try:
        part.mkdir(parents=True)
        for name in (*REQUIRED, *OPTIONAL):
            src = cached / name
            if src.exists():
                _place(src, part / name)
        if not is_usable(part):
            return False
        _swap_in(part, final)
        return True
    except OSError as e:
        log.warning("the cached speech model at %s cannot be read (%s)", cached, e)
        return False
    finally:
        shutil.rmtree(part, ignore_errors=True)


def ensure_model(model: str, models_root: Path, on_status: Optional[StatusFn] = None,
                 download: Optional[Callable[..., str]] = None) -> str:
    """Path to load `model` from. `model` may be a size ("small"), a Hugging Face repo id, or a folder
    the person set up themselves (returned unchanged). `download` is faster_whisper.download_model."""
    if model and Path(model).is_dir():
        return model
    final = models_root / folder_name(model)
    if is_usable(final):
        return str(final)
    if final.exists():
        log.warning("speech model folder %s is incomplete; rebuilding it", final)
    if download is None:
        from faster_whisper import download_model as download  # noqa: PLC0415

    models_root.mkdir(parents=True, exist_ok=True)
    try:
        cached = Path(download(model, local_files_only=True))
    except Exception:  # noqa: BLE001 - not in the cache (or the cache is broken): download below
        cached = None
    if cached is not None and adopt_cached(cached, final):
        log.info("speech model %s adopted from the Hugging Face cache into %s", model, final)
        return str(final)

    if on_status:
        on_status(f"Downloading the speech model '{model}' (one time)")
    part = final.with_name(final.name + ".part")
    shutil.rmtree(part, ignore_errors=True)
    try:
        download(model, output_dir=str(part))
        # the downloader leaves bookkeeping behind; only the model files matter
        shutil.rmtree(part / ".cache", ignore_errors=True)
        if not is_usable(part):
            raise RuntimeError(f"the speech model '{model}' did not download completely; check the internet connection and try again")
        _swap_in(part, final)
    finally:
        shutil.rmtree(part, ignore_errors=True)
    log.info("speech model %s downloaded to %s", model, final)
    return str(final)
