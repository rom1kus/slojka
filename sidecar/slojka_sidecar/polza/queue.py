"""Персистентная очередь задач polza.ai.

SQLite переживает перезапуски: незавершённые задачи возобновляют поллинг,
как только Electron передаст API-ключ (POST /polza/config). Поллинг с
backoff 2→30с, таймаут по умолчанию 15 минут, до 3 задач параллельно.
Результаты сразу скачиваются локально (CDN polza хранит 7 дней).
"""

import asyncio
import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from .client import PolzaClient, PolzaError

POLL_START_S = 2.0
POLL_MAX_S = 30.0
JOB_TIMEOUT_S = 15 * 60
MAX_CONCURRENT = 3

TERMINAL = {"completed", "failed", "cancelled", "timeout"}


class JobQueue:
    def __init__(self, data_dir: Path) -> None:
        self._client = PolzaClient()
        self._api_key: Optional[str] = None
        self._db_path = data_dir / "jobs.db"
        self._cache_dir = data_dir / "polza-cache"
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self._db_path, check_same_thread=False)
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                polza_id TEXT,
                kind TEXT NOT NULL,
                model TEXT NOT NULL,
                request_json TEXT NOT NULL,
                status TEXT NOT NULL,
                error TEXT,
                cost_rub REAL,
                result_files TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )"""
        )
        self._db.commit()
        self._tasks: dict[str, asyncio.Task] = {}
        self._sem = asyncio.Semaphore(MAX_CONCURRENT)

    # ── Публичное API ──

    def set_api_key(self, key: str) -> None:
        self._api_key = key or None
        if self._api_key:
            self._resume_pending()

    @property
    def has_key(self) -> bool:
        return self._api_key is not None

    def submit(self, kind: str, model: str, input_data: dict[str, Any]) -> dict:
        if not self._api_key:
            raise PolzaError("API-ключ polza.ai не задан")
        job_id = str(uuid.uuid4())
        now = time.time()
        self._db.execute(
            "INSERT INTO jobs (id, kind, model, request_json, status, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, 'pending', ?, ?)",
            (job_id, kind, model, json.dumps(input_data), now, now),
        )
        self._db.commit()
        self._tasks[job_id] = asyncio.get_event_loop().create_task(self._run(job_id))
        return self.get(job_id)

    def get(self, job_id: str) -> dict:
        row = self._db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise PolzaError(f"нет задачи {job_id}")
        return self._row_to_dict(row)

    def list_jobs(self, limit: int = 50) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def cancel(self, job_id: str) -> None:
        task = self._tasks.pop(job_id, None)
        if task:
            task.cancel()
        self._update(job_id, status="cancelled")

    def remove(self, job_id: str) -> None:
        """Убрать задачу из списка (активную — отменить) вместе с кэшем результатов."""
        task = self._tasks.pop(job_id, None)
        if task:
            task.cancel()
        try:
            files = self.get(job_id).get("result_files") or []
        except PolzaError:
            files = []
        for name in files:
            (self._cache_dir / name).unlink(missing_ok=True)
        self._db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        self._db.commit()

    def clear_finished(self) -> int:
        """Удалить все завершённые задачи (completed/failed/cancelled/timeout)."""
        rows = self._db.execute(
            "SELECT id FROM jobs WHERE status IN ('completed', 'failed', 'cancelled', 'timeout')"
        ).fetchall()
        for (job_id,) in rows:
            self.remove(job_id)
        return len(rows)

    def result_file(self, job_id: str, index: int = 0) -> Path:
        job = self.get(job_id)
        files = job.get("result_files") or []
        if index >= len(files):
            raise PolzaError("нет такого результата")
        return self._cache_dir / files[index]

    # ── Внутреннее ──

    def _resume_pending(self) -> None:
        rows = self._db.execute(
            "SELECT id FROM jobs WHERE status IN ('pending', 'processing')"
        ).fetchall()
        loop = asyncio.get_event_loop()
        for (job_id,) in rows:
            if job_id not in self._tasks:
                self._tasks[job_id] = loop.create_task(self._run(job_id))

    async def _run(self, job_id: str) -> None:
        try:
            async with self._sem:
                await self._run_inner(job_id)
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001 — статус задачи важнее типа ошибки
            self._update(job_id, status="failed", error=str(e))
        finally:
            self._tasks.pop(job_id, None)

    async def _run_inner(self, job_id: str) -> None:
        assert self._api_key
        job = self.get(job_id)
        polza_id = job.get("polza_id")

        if not polza_id:
            request = json.loads(job["request_json"])
            created = await self._client.create_media(
                self._api_key, job["model"], request
            )
            polza_id = created.get("id")
            if not polza_id:
                raise PolzaError("polza не вернула id задачи")
            status = created.get("status", "pending")
            # base64-вложения нужны только до создания задачи (resume);
            # дальше это мёртвые мегабайты в БД — вычищаем.
            self._update(
                job_id,
                polza_id=polza_id,
                status=status,
                request_json=json.dumps(_strip_media(request)),
            )
            if status in TERMINAL:
                await self._finalize(job_id, created)
                return

        deadline = time.time() + JOB_TIMEOUT_S
        delay = POLL_START_S
        while time.time() < deadline:
            await asyncio.sleep(delay)
            delay = min(delay * 1.7, POLL_MAX_S)
            data = await self._client.get_media(self._api_key, polza_id)
            status = data.get("status", "processing")
            self._update(job_id, status=status)
            if status in TERMINAL:
                await self._finalize(job_id, data)
                return
        self._update(job_id, status="timeout", error="превышен таймаут ожидания")

    async def _finalize(self, job_id: str, data: dict) -> None:
        cost = (data.get("usage") or {}).get("cost_rub")
        if data.get("status") != "completed":
            err = data.get("error")
            msg = err.get("message") if isinstance(err, dict) else err
            self._update(job_id, cost_rub=cost, error=str(msg) if msg else None)
            return

        # Результат: собираем URL картинок из data и скачиваем в кэш.
        urls = _extract_urls(data.get("data"))
        files: list[str] = []
        for i, url in enumerate(urls[:8]):
            try:
                blob = await self._client.download(url)
                ext = ".png" if ".png" in url.lower() else ".jpg"
                name = f"{job_id}-{i}{ext}"
                (self._cache_dir / name).write_bytes(blob)
                files.append(name)
            except Exception as e:  # noqa: BLE001
                self._update(job_id, error=f"скачивание результата: {e}")
        self._update(job_id, cost_rub=cost, result_files=json.dumps(files))

    def _update(self, job_id: str, **fields: Any) -> None:
        sets = ", ".join(f"{k} = ?" for k in fields)
        self._db.execute(
            f"UPDATE jobs SET {sets}, updated_at = ? WHERE id = ?",  # noqa: S608
            (*fields.values(), time.time(), job_id),
        )
        self._db.commit()

    def _row_to_dict(self, row: tuple) -> dict:
        cols = [
            "id",
            "polza_id",
            "kind",
            "model",
            "request_json",
            "status",
            "error",
            "cost_rub",
            "result_files",
            "created_at",
            "updated_at",
        ]
        d = dict(zip(cols, row))
        d["result_files"] = json.loads(d["result_files"]) if d["result_files"] else []
        return d


def _strip_media(input_data: dict[str, Any]) -> dict[str, Any]:
    """Заменяет base64-данные вложений пустышками в сохранённом запросе."""
    out = dict(input_data)
    for key in ("images", "videos"):
        items = out.get(key)
        if isinstance(items, list):
            out[key] = [
                {**i, "data": ""}
                if isinstance(i, dict) and i.get("type") == "base64"
                else i
                for i in items
            ]
    return out


def _extract_urls(data: Any) -> list[str]:
    """data бывает списком/объектом с url/image_url/output — собираем все URL."""
    urls: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, str):
            if node.startswith("http"):
                urls.append(node)
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return urls
