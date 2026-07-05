"""HTTP-маршруты polza-хаба."""

import base64
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..paths import data_dir as default_data_dir
from .client import PolzaClient, PolzaError
from .queue import JobQueue


class ConfigRequest(BaseModel):
    api_key: str


class GenerateRequest(BaseModel):
    kind: str  # generate | upscale | edit
    model: str
    input: dict[str, Any]


class CancelRequest(BaseModel):
    id: str


class ResultRequest(BaseModel):
    id: str
    index: int = 0


def make_polza_router(data_dir: Optional[Path] = None) -> APIRouter:
    router = APIRouter()
    queue = JobQueue(data_dir or default_data_dir())
    client = PolzaClient()

    @router.post("/config")
    async def config(req: ConfigRequest) -> dict:
        queue.set_api_key(req.api_key)
        return {"ok": True, "has_key": queue.has_key}

    @router.get("/status")
    async def status() -> dict:
        return {"has_key": queue.has_key}

    @router.get("/models")
    async def models() -> dict:
        if not queue.has_key:
            raise HTTPException(409, "API-ключ не задан")
        try:
            data = await client.list_models(queue._api_key or "")
            return {"models": data}
        except PolzaError as e:
            raise HTTPException(502, str(e)) from e

    @router.post("/generate")
    async def generate(req: GenerateRequest) -> dict:
        try:
            return queue.submit(req.kind, req.model, req.input)
        except PolzaError as e:
            raise HTTPException(409, str(e)) from e

    @router.get("/jobs")
    async def jobs() -> dict:
        return {"jobs": queue.list_jobs()}

    @router.post("/cancel")
    async def cancel(req: CancelRequest) -> dict:
        queue.cancel(req.id)
        return {"ok": True}

    @router.post("/remove")
    async def remove(req: CancelRequest) -> dict:
        queue.remove(req.id)
        return {"ok": True}

    @router.post("/clear-finished")
    async def clear_finished() -> dict:
        return {"removed": queue.clear_finished()}

    @router.post("/result")
    async def result(req: ResultRequest) -> dict:
        try:
            path = queue.result_file(req.id, req.index)
            return {
                "filename": path.name,
                "png_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
            }
        except (PolzaError, OSError) as e:
            raise HTTPException(404, str(e)) from e

    return router
