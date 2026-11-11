"""Optional ElevenLabs text-to-speech voiceover. Off unless ELEVENLABS_API_KEY is set."""
from __future__ import annotations

import logging
from typing import Any, Optional

from .. import ffmpeg
from ..config import Settings
from ..db import new_id
from ..runner import JobContext, PermanentError

log = logging.getLogger("klipz.voiceover")

API_BASE = "https://api.elevenlabs.io/v1"
DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM"
DEFAULT_MODEL = "eleven_multilingual_v2"
MAX_CHARS = 5000


def synthesize(settings: Settings, text: str, voice_id: Optional[str] = None, *, transport: Any = None) -> bytes:
    """POST to the ElevenLabs TTS REST API; returns MP3 bytes. `transport` is for tests."""
    import httpx

    if not settings.elevenlabs_api_key:
        raise PermanentError("voiceover needs ELEVENLABS_API_KEY")
    voice = voice_id or DEFAULT_VOICE
    if not voice.replace("-", "").replace("_", "").isalnum():
        raise PermanentError("invalid voice_id")
    with httpx.Client(transport=transport, timeout=120) as client:
        r = client.post(
            f"{API_BASE}/text-to-speech/{voice}",
            params={"output_format": "mp3_44100_128"},
            headers={"xi-api-key": settings.elevenlabs_api_key, "accept": "audio/mpeg"},
            json={"text": text, "model_id": DEFAULT_MODEL},
        )
    if r.status_code in (400, 401, 403, 404, 422):
        raise PermanentError(f"ElevenLabs rejected the request ({r.status_code}): {r.text[:200]}")
    if r.status_code >= 400:
        raise RuntimeError(f"ElevenLabs error {r.status_code}: {r.text[:200]}")  # 429/5xx: retry
    if not r.content:
        raise RuntimeError("ElevenLabs returned no audio")
    return r.content


def voiceover(ctx: JobContext, text: str, voice_id: Optional[str] = None, *, transport: Any = None) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        raise PermanentError("payload.text is required")
    if len(text) > MAX_CHARS:
        raise PermanentError(f"voiceover text is limited to {MAX_CHARS} characters")
    audio = synthesize(ctx.settings, text, voice_id, transport=transport)
    key = f"assets/voiceover-{new_id()}.mp3"
    dest = ctx.settings.storage_path(key)
    part = dest.with_name(dest.name + ".part")
    part.write_bytes(audio)
    try:
        duration = audio_duration(part)
    except Exception as e:  # noqa: BLE001
        part.unlink(missing_ok=True)
        raise RuntimeError(f"voiceover audio unreadable: {e}") from e
    part.replace(dest)
    return {"storage_key": key, "duration_sec": round(duration, 3)}


def audio_duration(path: Any) -> float:
    import json
    import subprocess

    res = subprocess.run([ffmpeg.binaries()[1], "-v", "error", "-print_format", "json", "-show_format", str(path)],
                         capture_output=True, text=True, errors="replace")
    if res.returncode != 0:
        raise ffmpeg.FfmpegError(res.stderr[-300:])
    return float(json.loads(res.stdout)["format"]["duration"])


def handle_voiceover(ctx: JobContext) -> dict[str, Any]:
    if not ctx.settings.elevenlabs_api_key:
        raise PermanentError("voiceover needs ELEVENLABS_API_KEY")
    p = ctx.payload
    if not p.get("clip_id"):
        raise PermanentError("payload.clip_id is required")
    return voiceover(ctx, str(p.get("text") or ""), p.get("voice_id"))


HANDLERS = {"voiceover": handle_voiceover}
