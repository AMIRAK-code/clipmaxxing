"""AI settings entered in the app (AI tab), read by the worker for every job.

The web app writes <data dir>/ai-settings.json. API keys in it are sealed with the same AES-256-GCM
key as the social tokens (`v1:<iv>:<tag>:<ciphertext>`, base64url; key = TOKEN_ENCRYPTION_KEY or
<data dir>/secret.key). Real environment variables always win over the file, so an existing
.env.local setup keeps working. The file is re-read on each call: no restart after changing settings.
"""
from __future__ import annotations

import base64
import dataclasses
import json
import logging
import os
from pathlib import Path
from typing import Any, Optional

from .config import Settings

log = logging.getLogger("klipz.ai_settings")

FILE_NAME = "ai-settings.json"
PROVIDERS = ("auto", "anthropic", "openai", "ollama", "none")


def _b64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _key(data_dir: Path) -> Optional[bytes]:
    raw = os.environ.get("TOKEN_ENCRYPTION_KEY", "").strip()
    if not raw:
        try:
            raw = (data_dir / "secret.key").read_text(encoding="utf-8").strip()
        except OSError:
            return None
    try:
        key = base64.b64decode(raw)
    except Exception:  # noqa: BLE001
        return None
    return key if len(key) == 32 else None


def unseal(enc: Any, data_dir: Path) -> str:
    """Decrypt a sealed value; '' when it is missing or cannot be decrypted (never raises)."""
    if not isinstance(enc, str) or not enc:
        return ""
    parts = enc.split(":")
    if len(parts) != 4 or parts[0] != "v1":
        return ""
    key = _key(data_dir)
    if key is None:
        return ""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        iv, tag, data = _b64u(parts[1]), _b64u(parts[2]), _b64u(parts[3])
        return AESGCM(key).decrypt(iv, data + tag, None).decode("utf-8")
    except Exception as e:  # noqa: BLE001
        log.warning("could not decrypt a saved AI key (%s); re-enter it in the AI tab", type(e).__name__)
        return ""


def read_file(data_dir: Path) -> dict[str, Any]:
    try:
        raw = json.loads((data_dir / FILE_NAME).read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _section(raw: dict[str, Any], name: str) -> dict[str, Any]:
    v = raw.get(name)
    return v if isinstance(v, dict) else {}


def _str(v: Any) -> str:
    return v.strip() if isinstance(v, str) else ""


def effective(settings: Settings) -> Settings:
    """`settings` with the AI tab's values filled in wherever the environment did not set one."""
    raw = read_file(settings.data_dir)
    if not raw:
        return settings
    env = os.environ
    d = settings.data_dir
    upd: dict[str, Any] = {}

    def fill(field: str, env_name: str, value: str) -> None:
        if value and not env.get(env_name, "").strip():
            upd[field] = value

    provider = _str(raw.get("provider")).lower()
    if provider in PROVIDERS:
        fill("llm_provider", "LLM_PROVIDER", provider)
    a, o, ol, el = _section(raw, "anthropic"), _section(raw, "openai"), _section(raw, "ollama"), _section(raw, "elevenlabs")
    fill("anthropic_api_key", "ANTHROPIC_API_KEY", unseal(a.get("keyEnc"), d))
    fill("anthropic_model", "ANTHROPIC_MODEL", _str(a.get("model")))
    fill("openai_api_key", "OPENAI_API_KEY", unseal(o.get("keyEnc"), d))
    fill("openai_base_url", "OPENAI_BASE_URL", _str(o.get("baseUrl")))
    fill("openai_model", "OPENAI_MODEL", _str(o.get("model")))
    fill("ollama_url", "OLLAMA_URL", _str(ol.get("url")))
    fill("ollama_model", "OLLAMA_MODEL", _str(ol.get("model")))
    fill("elevenlabs_api_key", "ELEVENLABS_API_KEY", unseal(el.get("keyEnc"), d))
    if isinstance(raw.get("smartEdit"), bool) and not env.get("KLIPZ_SMART_EDIT", "").strip():
        upd["smart_edit"] = raw["smartEdit"]
    return dataclasses.replace(settings, **upd) if upd else settings
