"""Мок polza.ai для тестов очереди: задача проходит pending → processing →
completed за N поллов и отдаёт крошечный PNG. Запуск: python mock_polza.py <port>.
"""

import base64
import sys
import uuid

from fastapi import FastAPI, Response
import uvicorn

# 1×1 красный PNG.
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)

app = FastAPI()
jobs: dict[str, dict] = {}


@app.post("/api/v1/media")
async def create(body: dict) -> dict:
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"polls": 0, "model": body.get("model")}
    return {"id": job_id, "status": "pending", "object": "media.generation"}


@app.get("/api/v1/media/{job_id}")
async def status(job_id: str, request_port: int = 0) -> dict:
    job = jobs.get(job_id)
    if not job:
        return {"error": {"message": "not found"}}
    job["polls"] += 1
    if job["polls"] < 2:
        return {"id": job_id, "status": "processing"}
    return {
        "id": job_id,
        "status": "completed",
        "usage": {"cost_rub": 1.23},
        "data": [{"url": f"http://127.0.0.1:{PORT}/file.png"}],
    }


@app.get("/file.png")
async def file() -> Response:
    return Response(content=TINY_PNG, media_type="image/png")


if __name__ == "__main__":
    PORT = int(sys.argv[1])
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="error")
