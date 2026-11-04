"""Import an untouched archived backend, with AI disabled before app.main imports."""
import argparse
import importlib
import logging
import os
import re
from pathlib import Path
import socket
import sys
import time
from urllib.parse import urlparse


def configure_measurement_pool(pool_size):
    if pool_size is None:
        logging.info("STAGE1 database pool: application defaults (no override)")
        return
    import sqlalchemy
    create_engine = sqlalchemy.create_engine
    def measurement_create_engine(*args, **kwargs):
        kwargs.update(pool_size=pool_size, max_overflow=0)
        return create_engine(*args, **kwargs)
    sqlalchemy.create_engine = measurement_create_engine
    logging.info("STAGE1 measurement database pool: pool_size=%d max_overflow=0", pool_size)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("backend", type=Path)
    parser.add_argument("port", type=int)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--measurement-pool-size", type=int)
    args = parser.parse_args()
    if args.measurement_pool_size is not None and not 1 <= args.measurement_pool_size <= 300:
        parser.error("--measurement-pool-size must be in [1, 300]")
    url = urlparse(args.database_url)
    if url.hostname != "127.0.0.1" or url.port != 55432:
        parser.error("DATABASE_URL must target 127.0.0.1:55432")
    if url.scheme not in ("postgresql", "postgresql+psycopg", "postgresql+psycopg2"):
        parser.error("Only PostgreSQL is allowed")
    if not re.fullmatch(r"/loadtest_[a-z0-9_]+", url.path) or url.query or url.fragment:
        parser.error("Only plain loadtest_* database URLs without query/fragment are allowed")
    if not 1024 <= args.port <= 65535:
        parser.error("Invalid server port")
    logs = Path(__file__).resolve().parents[1] / ".logs"
    logs.mkdir(exist_ok=True)
    log_path = logs / f"server-{url.path[1:]}-{os.getpid()}.log"
    sys.stdout = open(log_path, "a", buffering=1)
    sys.stderr = sys.stdout
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, force=True)
    os.environ.pop("GEMINI_API_KEY", None)
    os.environ.pop("GOOGLE_API_KEY", None)
    os.environ["SECRET_KEY"] = "stage1-fixed-local-test-secret-34-only"
    os.environ["ALGORITHM"] = "HS256"
    os.environ["DATABASE_URL"] = args.database_url
    import dotenv
    dotenv.load_dotenv = lambda *a, **kw: False

    # Also fail closed if an unexpected code path tries an outbound socket.
    original_connect = socket.socket.connect
    def local_connect(sock, address):
        if isinstance(address, tuple) and (address[0] != "127.0.0.1" or address[1] != 55432):
            raise RuntimeError(f"Stage1 outbound connection denied: {address}")
        return original_connect(sock, address)
    socket.socket.connect = local_connect
    # app.ai imports utils/models/database, so configure before any app import.
    configure_measurement_pool(args.measurement_pool_size)
    sys.path.insert(0, str(args.backend.resolve()))
    ai = importlib.import_module("app.ai")
    if not hasattr(ai, "client") or ai.client is not None:
        raise RuntimeError("AI client must exist and be None")
    async def welcome(*a, **kw):
        return "Stage1 fixed welcome."
    async def forbidden_dj(*a, **kw):
        raise RuntimeError("Stage1 forbids AI DJ calls")
    for name, replacement in (("get_ai_welcome_message", welcome), ("get_ai_dj_response", forbidden_dj)):
        if hasattr(ai, name):
            setattr(ai, name, replacement)
            logging.info("STAGE1 AI replacement applied: %s; client=None", name)
        else:
            logging.info("STAGE1 AI replacement absent: %s", name)
    app = importlib.import_module("app.main").app
    import uvicorn
    class MeasuredServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.started:
                print(f"STAGE1_LISTEN_MS={int(time.time() * 1000)}", flush=True)
    config = uvicorn.Config(app, host="127.0.0.1", port=args.port, workers=1,
                            timeout_graceful_shutdown=1, log_config=None)
    MeasuredServer(config).run()


if __name__ == "__main__":
    main()
