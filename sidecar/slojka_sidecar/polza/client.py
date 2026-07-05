"""Тонкий клиент polza.ai media API.

POST https://polza.ai/api/v1/media  {model, input, async: true}
GET  https://polza.ai/api/v1/media/{id}
Статусы: pending | processing | completed | failed | cancelled.
Латентность непредсказуема (секунды…минуты) — вся логика ожидания в queue.py.
"""

import os
from typing import Any

import httpx

# Переопределяется в тестах (мок-сервер polza).
BASE_URL = os.environ.get("SLOJKA_POLZA_URL", "https://polza.ai/api/v1")


class PolzaError(Exception):
    pass


class PolzaClient:
    def __init__(self) -> None:
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=15.0))

    async def create_media(
        self, api_key: str, model: str, input_data: dict[str, Any]
    ) -> dict[str, Any]:
        resp = await self._http.post(
            f"{BASE_URL}/media",
            headers=self._headers(api_key),
            json={"model": model, "input": input_data, "async": True},
        )
        return self._parse(resp)

    async def get_media(self, api_key: str, media_id: str) -> dict[str, Any]:
        resp = await self._http.get(
            f"{BASE_URL}/media/{media_id}", headers=self._headers(api_key)
        )
        return self._parse(resp)

    async def list_models(self, api_key: str) -> list[dict[str, Any]]:
        """Список image-моделей (если endpoint недоступен — вызывающий использует свой)."""
        resp = await self._http.get(
            f"{BASE_URL}/models",
            params={"type": "image"},
            headers=self._headers(api_key),
        )
        data = self._parse(resp)
        models = data.get("data", data.get("models", []))
        return models if isinstance(models, list) else []

    async def download(self, url: str) -> bytes:
        # Результаты бывают большими (8×-апскейл — десятки МБ), а канал —
        # за прокси: обычного 60-секундного таймаута может не хватить.
        resp = await self._http.get(
            url,
            follow_redirects=True,
            timeout=httpx.Timeout(600.0, connect=15.0),
        )
        resp.raise_for_status()
        return resp.content

    @staticmethod
    def _headers(api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}"}

    @staticmethod
    def _parse(resp: httpx.Response) -> dict[str, Any]:
        try:
            data = resp.json()
        except ValueError as e:
            raise PolzaError(f"HTTP {resp.status_code}: не-JSON ответ") from e
        if resp.status_code >= 400:
            msg = (
                data.get("error", {}).get("message")
                if isinstance(data.get("error"), dict)
                else data.get("error")
            ) or f"HTTP {resp.status_code}"
            raise PolzaError(str(msg))
        return data
