"""Transcription: 16 kHz mono audio -> word timestamps (+ optional diarization)."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from ..config import Settings
from ..runner import JobContext, PermanentError
from . import segment as seg
from .ingest import ingest

log = logging.getLogger("klipz.transcribe")

ProgressFn = Callable[[float], None]


class Transcriber(Protocol):
    name: str

    def transcribe(self, audio_path: Path, duration: float, on_progress: ProgressFn) -> dict[str, Any]:
        """Return {language, words:[{w,s,e,p?,spk?}], model}."""
        ...


# Tests (and an orchestrator) can inject a transcriber here.
_override: Optional[Transcriber] = None


def set_transcriber_override(t: Optional[Transcriber]) -> None:
    global _override
    _override = t


class FasterWhisperTranscriber:
    name = "faster-whisper"

    def __init__(self, model: str = "small", device: str = "auto"):
        self.model_name, self.device = model, device

    def _load(self, device: str, compute_type: str) -> Any:
        from faster_whisper import WhisperModel

        return WhisperModel(self.model_name, device=device, compute_type=compute_type)

    def _run(self, model: Any, audio_path: Path, duration: float, on_progress: ProgressFn) -> dict[str, Any]:
        segments, info = model.transcribe(
            str(audio_path), word_timestamps=True, vad_filter=True, beam_size=5, condition_on_previous_text=False
        )
        words: list[dict[str, Any]] = []
        for s in segments:  # generator: inference happens here
            for w in s.words or []:
                text = w.word.strip()
                if text:
                    words.append({"w": text, "s": round(float(w.start), 3), "e": round(float(w.end), 3),
                                  "p": round(float(w.probability), 3)})
            if duration > 0:
                on_progress(min(1.0, float(s.end) / duration))
        return {"language": getattr(info, "language", None), "words": words,
                "model": f"faster-whisper:{self.model_name}"}

    def transcribe(self, audio_path: Path, duration: float, on_progress: ProgressFn) -> dict[str, Any]:
        attempts: list[tuple[str, str]]
        if self.device == "cpu":
            attempts = [("cpu", "int8")]
        elif self.device == "cuda":
            attempts = [("cuda", "float16"), ("cpu", "int8")]
        else:
            attempts = [("cuda", "float16"), ("cpu", "int8")]
        last: Optional[Exception] = None
        for device, ctype in attempts:
            try:
                model = self._load(device, ctype)
                return self._run(model, audio_path, duration, on_progress)
            except Exception as e:  # noqa: BLE001 - any load/inference error falls through to CPU
                log.warning("faster-whisper on %s/%s failed (%s); trying next option", device, ctype, e)
                last = e
        raise RuntimeError(f"transcription failed: {last}")


class WhisperXTranscriber:
    """Optional: forced alignment + pyannote diarization (needs whisperx and HF_TOKEN)."""

    name = "whisperx"

    def __init__(self, model: str, device: str, hf_token: str):
        self.model_name, self.device, self.hf_token = model, device, hf_token

    def transcribe(self, audio_path: Path, duration: float, on_progress: ProgressFn) -> dict[str, Any]:
        import whisperx  # type: ignore[import-not-found]

        device = "cpu" if self.device == "cpu" else "cuda"
        ctype = "float16" if device == "cuda" else "int8"
        try:
            model = whisperx.load_model(self.model_name, device, compute_type=ctype)
        except Exception:  # noqa: BLE001
            device, ctype = "cpu", "int8"
            model = whisperx.load_model(self.model_name, device, compute_type=ctype)
        audio = whisperx.load_audio(str(audio_path))
        on_progress(0.1)
        result = model.transcribe(audio, batch_size=8)
        language = result.get("language")
        on_progress(0.6)
        align_model, meta = whisperx.load_align_model(language_code=language, device=device)
        result = whisperx.align(result["segments"], align_model, meta, audio, device)
        on_progress(0.8)
        if self.hf_token:
            try:
                from whisperx.diarize import DiarizationPipeline  # type: ignore[import-not-found]
            except Exception:  # noqa: BLE001
                DiarizationPipeline = whisperx.DiarizationPipeline  # type: ignore[attr-defined]  # noqa: N806
            diar = DiarizationPipeline(use_auth_token=self.hf_token, device=device)(audio)
            result = whisperx.assign_word_speakers(diar, result)
        words: list[dict[str, Any]] = []
        for s in result.get("segments", []):
            for w in s.get("words", []):
                if "start" not in w or "end" not in w:
                    continue
                item: dict[str, Any] = {"w": str(w["word"]).strip(), "s": round(float(w["start"]), 3),
                                        "e": round(float(w["end"]), 3)}
                if "score" in w:
                    item["p"] = round(float(w["score"]), 3)
                if w.get("speaker"):
                    item["spk"] = str(w["speaker"])
                words.append(item)
        on_progress(1.0)
        return {"language": language, "words": words, "model": f"whisperx:{self.model_name}"}


def pick_transcriber(settings: Settings) -> Transcriber:
    if _override is not None:
        return _override
    want = (settings.transcriber or "auto").lower()
    if want in ("whisperx", "auto"):
        try:
            import whisperx  # type: ignore[import-not-found]  # noqa: F401

            return WhisperXTranscriber(settings.whisper_model, settings.whisper_device, settings.hf_token)
        except Exception:  # noqa: BLE001
            if want == "whisperx":
                log.warning("TRANSCRIBER=whisperx but whisperx is not importable; using faster-whisper")
    return FasterWhisperTranscriber(settings.whisper_model, settings.whisper_device)


def normalise_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort, drop junk, ensure e>=s, and default speaker to S1."""
    out: list[dict[str, Any]] = []
    for w in sorted(words, key=lambda x: (float(x.get("s", 0)), float(x.get("e", 0)))):
        text = str(w.get("w", "")).strip()
        if not text:
            continue
        s = float(w["s"])
        e = max(float(w.get("e", s)), s)
        item: dict[str, Any] = {"w": text, "s": round(s, 3), "e": round(e, 3)}
        if w.get("p") is not None:
            item["p"] = float(w["p"])
        item["spk"] = str(w.get("spk") or "S1")
        out.append(item)
    return out


def transcribe(ctx: JobContext, source_video_id: str, *, force: bool = False) -> dict[str, Any]:
    """Idempotent: returns the existing transcript row unless `force`."""
    db = ctx.db
    existing = db.one("transcripts", "select * from transcripts where source_video_id = ?", source_video_id)
    if existing and not force:
        return existing
    source = ingest(ctx.sub(0.0, 0.1), source_video_id)
    audio_key = source.get("audio_key")
    if not audio_key:
        raise PermanentError("source has no extracted audio")
    audio_path = ctx.settings.storage_path(audio_key)
    duration = float(source.get("duration_sec") or 0)
    tr = pick_transcriber(ctx.settings)
    tctx = ctx.sub(0.1, 0.95)
    tctx.progress(0.0, "Transcribing")
    try:
        result = tr.transcribe(audio_path, duration, lambda p: tctx.progress(p))
    except Exception as e:  # noqa: BLE001
        if _override is None and tr.name == "whisperx" and (ctx.settings.transcriber or "auto").lower() == "auto":
            log.warning("whisperx failed (%s); falling back to faster-whisper", e)
            tr = FasterWhisperTranscriber(ctx.settings.whisper_model, ctx.settings.whisper_device)
            result = tr.transcribe(audio_path, duration, lambda p: tctx.progress(p))
        else:
            raise
    words = normalise_words(result.get("words") or [])
    sentences = seg.build_sentences(words)
    speakers = sorted({w["spk"] for w in words}) or ["S1"]
    row = {
        "language": result.get("language"),
        "words": words,
        "segments": seg.sentences_to_segments(sentences),
        "speakers": speakers,
        "model": result.get("model") or tr.name,
    }
    if existing:
        db.update("transcripts", existing["id"], row)
    else:
        db.insert("transcripts", {"source_video_id": source_video_id, **row})
    ctx.progress(1.0, "Transcribed", force=True)
    return db.one("transcripts", "select * from transcripts where source_video_id = ?", source_video_id)  # type: ignore[return-value]


def handle_transcribe(ctx: JobContext) -> dict[str, Any]:
    sid = ctx.payload.get("source_video_id")
    if not sid:
        raise PermanentError("payload.source_video_id is required")
    t = transcribe(ctx, sid, force=bool(ctx.payload.get("force")))
    return {"source_video_id": sid, "words": len(t["words"]), "language": t["language"], "model": t["model"]}
