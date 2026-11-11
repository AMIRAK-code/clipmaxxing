"""Job-type -> handler registry. Later tracks add reframe/render/autoclip here."""
from __future__ import annotations

from .runner import Handler
from .steps.analyze import handle_analyze
from .steps.ingest import handle_ingest
from .steps.transcribe import handle_transcribe
from .steps.youtube import handle_import_youtube

_EXTRA: dict[str, Handler] = {}


def register(job_type: str, handler: Handler) -> None:
    """Register an additional handler (call before build_handlers / from a step module)."""
    _EXTRA[job_type] = handler


def build_handlers() -> dict[str, Handler]:
    handlers: dict[str, Handler] = {
        "import_youtube": handle_import_youtube,
        "ingest": handle_ingest,
        "transcribe": handle_transcribe,
        "analyze": handle_analyze,
    }
    # Optional handlers from later tracks: any module exposing HANDLERS = {type: fn}.
    for mod in ("reframe", "render", "autoclip", "voiceover", "cleanup"):
        try:
            m = __import__(f"klipz_worker.steps.{mod}", fromlist=["HANDLERS"])
            handlers.update(getattr(m, "HANDLERS", {}))
        except ModuleNotFoundError as e:
            if e.name != f"klipz_worker.steps.{mod}":
                raise  # a real missing dependency inside the module: do not hide it
    handlers.update(_EXTRA)
    return handlers
