"""FastAPI-приложение sidecar: /health, /sam/*, /polza/*."""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__
from .polza.routes import make_polza_router
from .sam.service import SamService


def create_app(token: str) -> FastAPI:
    app = FastAPI(title="slojka-sidecar", version=__version__)
    sam = SamService()

    @app.middleware("http")
    async def check_auth(request: Request, call_next):
        auth = request.headers.get("authorization", "")
        if auth != f"Bearer {token}":
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        return await call_next(request)

    @app.get("/health")
    async def health() -> dict:
        return {
            "status": "ok",
            "version": __version__,
            "sam": sam.status(),
        }

    app.include_router(sam.router, prefix="/sam")
    app.include_router(make_polza_router(), prefix="/polza")
    return app
