"""Face detection. A Detector maps one RGB frame to faces in normalised
coordinates; the planner never touches MediaPipe directly so tests inject a fake."""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol

import numpy as np

log = logging.getLogger("klipz.reframe.detect")

MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
)
MODEL_NAME = "face_landmarker.task"


@dataclass(frozen=True)
class Face:
    """Normalised (0..1) face box centre/size in the source frame."""

    cx: float
    cy: float
    w: float
    h: float
    mouth: Optional[float] = None  # inner-lip gap / face height; None when landmarks are unavailable
    conf: float = 1.0

    @property
    def area(self) -> float:
        return self.w * self.h


class Detector(Protocol):
    def detect(self, frame_rgb: np.ndarray) -> list[Face]: ...


class NoFaceDetector:
    """Used when no real detector can be loaded: every shot falls back to a centre crop."""

    name = "none"

    def detect(self, frame_rgb: np.ndarray) -> list[Face]:  # noqa: ARG002
        return []


class DetectorUnavailable(RuntimeError):
    pass


# ── model cache ──────────────────────────────────────────────────────────
_download_failed_at: float = 0.0
_RETRY_AFTER = 600.0
_lock = threading.Lock()


def model_path(data_dir: Path) -> Path:
    """<data dir>/models/face_landmarker.task, or $KLIPZ_MODEL_DIR/face_landmarker.task."""
    override = os.environ.get("KLIPZ_MODEL_DIR", "").strip()
    return (Path(override) if override else data_dir / "models") / MODEL_NAME


def ensure_model(data_dir: Path, *, transport: Any = None, allow_download: Optional[bool] = None) -> Optional[Path]:
    """Return the cached face-landmarker model, downloading the official Google
    file once. Returns None (soft failure) when offline or downloads are disabled
    (KLIPZ_MODEL_DOWNLOAD=0)."""
    global _download_failed_at
    path = model_path(data_dir)
    if path.exists() and path.stat().st_size > 100_000:
        return path
    if allow_download is None:
        allow_download = os.environ.get("KLIPZ_MODEL_DOWNLOAD", "1").strip() not in ("0", "false", "no")
    if not allow_download:
        return None
    with _lock:
        if time.monotonic() - _download_failed_at < _RETRY_AFTER and _download_failed_at:
            return None
        import httpx

        tmp = path.with_suffix(".task.part")
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            log.info("downloading MediaPipe face model (one time) -> %s", path)
            with httpx.Client(transport=transport, timeout=60, follow_redirects=True) as client:
                with client.stream("GET", MODEL_URL) as r:
                    r.raise_for_status()
                    with open(tmp, "wb") as f:
                        for chunk in r.iter_bytes(1 << 16):
                            f.write(chunk)
            if tmp.stat().st_size < 100_000:
                raise RuntimeError("downloaded model is implausibly small")
            tmp.replace(path)
            return path
        except Exception as e:  # noqa: BLE001 - offline must not break reframing
            _download_failed_at = time.monotonic()
            log.warning("could not fetch the face model (%s); using centre-crop fallback", e)
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            return None


class MediaPipeDetector:
    """MediaPipe Tasks FaceLandmarker: boxes + 478 landmarks (mouth openness)."""

    name = "mediapipe-face-landmarker"
    UPPER_LIP, LOWER_LIP, FOREHEAD, CHIN = 13, 14, 10, 152

    def __init__(self, model_file: Path, max_faces: int = 4):
        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions, vision
        except Exception as e:  # noqa: BLE001
            raise DetectorUnavailable(f"mediapipe import failed: {e}") from e
        self._mp = mp
        opts = vision.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=str(model_file)),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=max_faces,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
        )
        try:
            self._landmarker = vision.FaceLandmarker.create_from_options(opts)
        except Exception as e:  # noqa: BLE001
            raise DetectorUnavailable(f"could not load face model: {e}") from e

    def detect(self, frame_rgb: np.ndarray) -> list[Face]:
        img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame_rgb))
        res = self._landmarker.detect(img)
        return faces_from_landmarks(res.face_landmarks)

    def close(self) -> None:
        try:
            self._landmarker.close()
        except Exception:  # noqa: BLE001
            pass


def faces_from_landmarks(face_landmarks: Any) -> list[Face]:
    """Convert MediaPipe landmark lists (objects with .x/.y) to Face records."""
    out: list[Face] = []
    for lms in face_landmarks or []:
        xs = [p.x for p in lms]
        ys = [p.y for p in lms]
        if not xs:
            continue
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        w, h = max(1e-4, x1 - x0), max(1e-4, y1 - y0)
        mouth: Optional[float] = None
        if len(lms) > MediaPipeDetector.CHIN:
            gap = abs(lms[MediaPipeDetector.LOWER_LIP].y - lms[MediaPipeDetector.UPPER_LIP].y)
            mouth = float(gap / h)
        out.append(Face(cx=(x0 + x1) / 2, cy=(y0 + y1) / 2, w=w, h=h, mouth=mouth))
    return out


def default_detector(data_dir: Path) -> Any:
    """Best available detector; never raises."""
    model = ensure_model(data_dir)
    if model is None:
        return NoFaceDetector()
    try:
        return MediaPipeDetector(model)
    except DetectorUnavailable as e:
        log.warning("%s; using centre-crop fallback", e)
        return NoFaceDetector()
