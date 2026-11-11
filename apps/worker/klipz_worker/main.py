"""Entry point: python -m klipz_worker.main [--once] [--no-api] [--port N]"""
from __future__ import annotations

import argparse
import logging
import threading
from typing import Any, Optional

from .config import Settings
from .handlers import build_handlers
from .runner import Runner

log = logging.getLogger("klipz.main")
HOST = "127.0.0.1"  # loopback only


def create_app(runner: Runner) -> Any:
    from fastapi import FastAPI

    app = FastAPI(title="klipz-worker", docs_url=None, redoc_url=None)

    @app.get("/health")
    def health() -> dict[str, Any]:
        job = runner.current_job
        return {
            "ok": True,
            "worker_id": runner.settings.worker_id,
            "handlers": sorted(runner.handlers),
            "current_job": None if job is None else {"id": job["id"], "type": job["type"],
                                                     "attempt": job["attempts"]},
        }

    return app


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="klipz_worker")
    ap.add_argument("--once", action="store_true", help="process one job and exit")
    ap.add_argument("--no-api", action="store_true", help="do not start the status API")
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    runner = Runner(Settings(), build_handlers())
    if args.once:
        handled = runner.run_once()
        log.info("processed a job" if handled else "queue empty")
        return 0

    t = threading.Thread(target=runner.run_forever, name="runner", daemon=True)
    t.start()
    try:
        if args.no_api:
            t.join()
        else:
            import uvicorn

            uvicorn.run(create_app(runner), host=HOST, port=args.port, log_level="warning")
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop()
        t.join(timeout=10)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
