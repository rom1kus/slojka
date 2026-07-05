"""Точка входа sidecar.

Протокол запуска: слушаем 127.0.0.1 на свободном порту, печатаем в stdout
одну строку `SLOJKA_READY {"port": N, "pid": P}` — Electron её парсит.
Все запросы требуют Bearer-токен из env SLOJKA_TOKEN.
"""

import argparse
import json
import os
import socket
import sys
import threading
import time

import uvicorn

from .app import create_app


def _parent_alive(parent_pid: int) -> bool:
    if os.name == "nt":
        # Windows не переусыновляет процессы — getppid бесполезен.
        # Проверяем сам процесс через OpenProcess + WaitForSingleObject.
        import ctypes

        SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x102
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
        if not handle:
            return False
        alive = kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        kernel32.CloseHandle(handle)
        return bool(alive)
    return os.getppid() == parent_pid


def _watch_parent(parent_pid: int) -> None:
    """Умираем вместе с родителем: если Electron убит жёстко (dev-перезапуск,
    kill -9), нас усыновляет init — без этого осиротевший sidecar держит
    гигабайты RAM (torch + модель SAM)."""
    while True:
        time.sleep(2.0)
        if not _parent_alive(parent_pid):
            os._exit(0)


def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()

    if args.parent_pid:
        threading.Thread(
            target=_watch_parent, args=(args.parent_pid,), daemon=True
        ).start()

    token = os.environ.get("SLOJKA_TOKEN", "")
    if not token:
        print("SLOJKA_FATAL нет SLOJKA_TOKEN", file=sys.stderr)
        sys.exit(2)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", args.port))
    port = sock.getsockname()[1]

    print(f'SLOJKA_READY {json.dumps({"port": port, "pid": os.getpid()})}', flush=True)

    app = create_app(token)
    config = uvicorn.Config(app, log_level="warning")
    server = uvicorn.Server(config)
    server.run(sockets=[sock])


if __name__ == "__main__":
    run()
