"""Paths and settings. Mirrors apps/web/src/server/paths.ts."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


def _load_env_file(path: Path) -> None:
    """Minimal .env reader: KEY=VALUE lines; never overrides real env vars."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


_load_env_file(REPO_ROOT / ".env")
_load_env_file(REPO_ROOT / ".env.local")


def data_dir() -> Path:
    d = Path(os.environ.get("KLIPZ_DATA_DIR", "").strip() or Path.home() / ".klipz")
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class Settings:
    data_dir: Path = field(default_factory=data_dir)
    migrations_dir: Path = REPO_ROOT / "db" / "migrations"
    worker_id: str = field(default_factory=lambda: f"worker-{os.getpid()}")
    poll_interval: float = float(os.environ.get("KLIPZ_POLL_INTERVAL", "1.0"))
    stale_seconds: int = int(os.environ.get("KLIPZ_STALE_SECONDS", "120"))
    # transcription
    whisper_model: str = os.environ.get("WHISPER_MODEL", "small")
    whisper_device: str = os.environ.get("WHISPER_DEVICE", "auto")  # auto | cuda | cpu
    transcriber: str = os.environ.get("TRANSCRIBER", "auto")  # auto | whisperx | faster-whisper
    hf_token: str = os.environ.get("HF_TOKEN", "")
    # scoring
    llm_provider: str = os.environ.get("LLM_PROVIDER", "auto")  # auto | anthropic | openai | ollama | none
    anthropic_api_key: str = os.environ.get("ANTHROPIC_API_KEY", "")
    anthropic_model: str = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5-5")
    ollama_url: str = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
    ollama_model: str = os.environ.get("OLLAMA_MODEL", "")
    # any OpenAI-compatible chat API: OpenAI, OpenRouter, Groq, LM Studio, llama.cpp server, vLLM ...
    openai_base_url: str = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
    openai_api_key: str = os.environ.get("OPENAI_API_KEY", "")
    openai_model: str = os.environ.get("OPENAI_MODEL", "")
    # Smart Edit: automatic jump cuts, punch-in zooms, emphasis, hook card and progress bar on new clips
    smart_edit: bool = os.environ.get("KLIPZ_SMART_EDIT", "1").strip().lower() not in ("0", "false", "no", "off")
    # optional paid extras – off unless a key is present
    elevenlabs_api_key: str = os.environ.get("ELEVENLABS_API_KEY", "")
    source_retention_days: int = int(os.environ.get("SOURCE_RETENTION_DAYS", "30"))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "klipz.db"

    @property
    def storage_dir(self) -> Path:
        d = self.data_dir / "storage"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def storage_path(self, key: str) -> Path:
        root = self.storage_dir.resolve()
        full = (root / key).resolve()
        if root != full and root not in full.parents:
            raise ValueError("invalid storage key")
        full.parent.mkdir(parents=True, exist_ok=True)
        return full
