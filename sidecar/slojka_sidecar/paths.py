"""Директория данных sidecar (jobs.db, модели, кэши результатов).

Первичен env SLOJKA_DATA_DIR — его ставит Electron-main, чтобы обе стороны
гарантированно смотрели в одно место на любой платформе. Фолбэки повторяют
логику main-процесса: Linux — ~/.local/share/slojka, Windows —
%APPDATA%/slojka (Electron userData), иначе ~/.slojka.
"""

import os
from pathlib import Path


def data_dir() -> Path:
    env = os.environ.get("SLOJKA_DATA_DIR")
    if env:
        return Path(env)
    if os.name == "posix":
        return Path.home() / ".local" / "share" / "slojka"
    appdata = os.environ.get("APPDATA")
    if appdata:
        return Path(appdata) / "slojka"
    return Path.home() / ".slojka"
